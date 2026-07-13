// Phase 3.0 M2 — "Acknowledge Backend CP Readiness Review" controlled-action PILOT handler.
//
// WHAT THIS IS: a PURE, NO-THROW, transport-agnostic handler for a DEV-only, POST-only, NON-DESTRUCTIVE
// controlled action. Its ONLY effect on success is emitting ONE advisory audit marker through the injected
// DEV sink. It mutates NO business data, touches NO live DB/Supabase/provider, and reads NOTHING from the
// request as authority (authority is the server-supplied principal + permission level).
//
// ORDERED GATES (fail-closed, gates-first): method → dev → flag → authorization → input validation →
// idempotency → success. Authorization runs BEFORE input validation so an unauthorized caller learns nothing
// about input validity (no oracle). The deny-path audit carries NO request-body data (safe 'n_a' placeholders).
//
// AUDIT COUNT (locked): method/dev/flag/validation/duplicate ⇒ 0 events; auth deny/blocked ⇒ 1 deny event;
// success (first accepted key) ⇒ 1 success event. Duplicate accepted key ⇒ 0 (first-write-wins dedupe).
//
// Server-side only. Never imported by src/ (the client bundle).

import { createHash } from 'node:crypto';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard'; // type-only.
import type { PermissionLevelValue } from '../platform-identity/authorizationConstants';
import { authorizeBcpAction } from './bcpActionAuthorizationGuard';
import { buildActionAuditEvent, type BcpActionAuditSink } from './bcpActionAuditSink';
import type { BcpActionIdempotencyStore, IdempotencyReservation } from './bcpActionIdempotencyStore';

/** Pinned action key (server-side only; never a request field). */
export const BCP_ACTION_ACK_KEY = 'bcp.action.acknowledge_readiness_review';

/** Closed set of acknowledgeable readiness lenses. */
export const ACK_LENS_KEYS = ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07', 'ALL'] as const;
export type AckLensKey = (typeof ACK_LENS_KEYS)[number];

/** Reason bounds (trimmed length). */
export const REASON_MIN = 3;
export const REASON_MAX = 280;
/** Idempotency/correlation key format. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,80}$/;
/** The exact allowed request-body keys (strict schema — any other key is rejected). */
const ALLOWED_BODY_KEYS = new Set(['confirm', 'reason', 'idempotencyKey', 'lensKey']);

export type AckCategory =
  | 'success' | 'duplicate' | 'idempotency_conflict' | 'busy' | 'dev_only' | 'feature_disabled'
  | 'not_authorized' | 'parity_blocked' | 'method_not_allowed' | 'invalid' | 'error';

export type AckValidationCode =
  | 'malformed_body' | 'unexpected_field' | 'confirmation_required'
  | 'reason_required' | 'reason_too_long' | 'reason_unsafe'
  | 'idempotency_key_required' | 'idempotency_key_invalid' | 'lens_invalid';

export interface AckRequest {
  method: string;
  isDevEnvironment: boolean;
  featureEnabled: boolean;
  principal: SyntheticServerPrincipal | null;
  platformPermissionLevel: PermissionLevelValue | null;
  planReadOnly?: boolean;
  planOverdue?: boolean;
  /** The raw, UNTRUSTED request body (validated here; never a source of authority). */
  body: unknown;
  /** Injected advisory audit sink (DEV-only; never durable). */
  sink: BcpActionAuditSink;
  /** Injected bounded, concurrency-safe idempotency store (in-memory; no DB; no durable fallback). */
  idempotencyStore: BcpActionIdempotencyStore;
  /** One-way fingerprint of the server-derived internal identity — scopes the idempotency key per principal. */
  principalFingerprint: string;
  hints?: NonAuthorityHints;
}

export interface AckResult {
  httpStatus: number;
  category: AckCategory;
  body: Record<string, unknown>;
}

// NOTE: this project is non-strict TS (strictNullChecks off), where discriminated-union narrowing on a
// boolean `ok` discriminant does not remove members. Use single interfaces with optional fields so property
// access is valid without narrowing; callers branch on `ok` and read the relevant optional field.
type ReasonCheck = { ok: boolean; value?: string; code?: AckValidationCode };
type BodyCheck = { ok: boolean; lensKey?: AckLensKey; idempotencyKey?: string; reasonValue?: string; code?: AckValidationCode };

/** One-way fingerprint of the authority-neutral payload (lens + sanitized reason). Raw reason is never stored. */
function payloadFingerprint(lensKey: string, reasonValue: string): string {
  return createHash('sha256').update(`v1 ${lensKey} ${reasonValue}`).digest('hex');
}

const invalid = (code: AckValidationCode): AckResult => ({ httpStatus: 400, category: 'invalid', body: { status: 'invalid', code } });

const FORBIDDEN_REASON_SUBSTR = ['://', '@', 'bearer', 'eyj', 'service_role', 'password', 'secret', 'token', 'apikey', 'api_key', '<script', 'javascript:'];

/** True if the string contains any ASCII control char (0x00-0x1f) or DEL (0x7f). No literal control chars in source. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Bound + sanitize the free-text reason. Returns the safe trimmed value on success, or a rejection code.
 * REJECTS unsafe content (never strips-and-accepts) so nothing questionable proceeds. The returned value is
 * used only transiently by the handler and is NEVER written to any audit event.
 */
export function sanitizeAckReason(raw: unknown): ReasonCheck {
  if (typeof raw !== 'string') return { ok: false, code: 'reason_required' };
  const trimmed = raw.trim();
  if (trimmed.length < REASON_MIN) return { ok: false, code: 'reason_required' };
  if (trimmed.length > REASON_MAX) return { ok: false, code: 'reason_too_long' };
  if (hasControlChar(trimmed)) return { ok: false, code: 'reason_unsafe' };
  const lower = trimmed.toLowerCase();
  for (const bad of FORBIDDEN_REASON_SUBSTR) if (lower.includes(bad)) return { ok: false, code: 'reason_unsafe' };
  if (!/^[A-Za-z0-9 .,:;'"()\-_/]+$/.test(trimmed)) return { ok: false, code: 'reason_unsafe' };
  return { ok: true, value: trimmed };
}

/** Validate the bounded, strict request body. Returns the parsed safe fields, or a rejection. */
function validateBody(body: unknown): BodyCheck {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'malformed_body' };
  const b = body as Record<string, unknown>;
  // Own-property only (defense-in-depth, mirroring the M43 guard hardening): reject any non-allow-listed OWN
  // key, and read each required field ONLY when it is an OWN property — an inherited/prototype value can never
  // satisfy a field. The handler never spreads/merges the body, so there is no pollution sink either.
  const hasOwn = (k: string): boolean => Object.prototype.hasOwnProperty.call(b, k);
  for (const k of Object.keys(b)) if (!ALLOWED_BODY_KEYS.has(k)) return { ok: false, code: 'unexpected_field' };
  if (!hasOwn('confirm') || b.confirm !== true) return { ok: false, code: 'confirmation_required' };
  if (!hasOwn('lensKey') || typeof b.lensKey !== 'string' || !(ACK_LENS_KEYS as readonly string[]).includes(b.lensKey)) return { ok: false, code: 'lens_invalid' };
  if (!hasOwn('idempotencyKey') || typeof b.idempotencyKey !== 'string') return { ok: false, code: 'idempotency_key_required' };
  if (!IDEMPOTENCY_KEY_RE.test(b.idempotencyKey)) return { ok: false, code: 'idempotency_key_invalid' };
  const reason = sanitizeAckReason(hasOwn('reason') ? b.reason : undefined);
  if (reason.ok) return { ok: true, lensKey: b.lensKey as AckLensKey, idempotencyKey: b.idempotencyKey, reasonValue: reason.value };
  return { ok: false, code: reason.code };
}

/**
 * Handle the controlled acknowledgement. PURE + FAIL-CLOSED + NO-THROW. Emits at most one advisory audit event.
 */
export function handleBcpActionAcknowledgeReadinessReview(req: AckRequest): AckResult {
  try {
    // 1. Method (POST only). app.post already restricts this at the mount; defense-in-depth here.
    if (req.method !== 'POST') return { httpStatus: 405, category: 'method_not_allowed', body: { status: 'method_not_allowed' } };
    // 2. DEV-only.
    if (!req.isDevEnvironment) return { httpStatus: 404, category: 'dev_only', body: { status: 'unavailable', reason: 'dev_only' } };
    // 3. Default-off flag.
    if (!req.featureEnabled) return { httpStatus: 404, category: 'feature_disabled', body: { status: 'unavailable', reason: 'feature_disabled' } };

    // 4. Authorization FIRST (no input oracle for unauthorized callers). Deny-path audit carries no body data.
    const guard = authorizeBcpAction({
      actionKey: BCP_ACTION_ACK_KEY,
      isDevEnvironment: req.isDevEnvironment,
      featureEnabled: req.featureEnabled,
      principal: req.principal,
      platformPermissionLevel: req.platformPermissionLevel,
      planReadOnly: req.planReadOnly,
      planOverdue: req.planOverdue,
      hints: req.hints,
    });
    if (guard.decision !== 'allow') {
      req.sink.record(buildActionAuditEvent({
        actionKey: BCP_ACTION_ACK_KEY,
        actorId: req.principal?.internalUserId ?? null,
        lensKey: 'n_a', decision: 'deny', reasonCode: guard.reasonCode, result: 'denied',
        confirmationAcknowledged: false, reasonProvided: false, correlationKey: 'n_a',
      }));
      if (guard.decision === 'blocked') return { httpStatus: 409, category: 'parity_blocked', body: { status: 'parity_blocked' } };
      return { httpStatus: 403, category: 'not_authorized', body: { status: 'not_authorized' } };
    }

    // 5. Bounded, strict input validation (only after authorization). No audit on validation failure.
    const v = validateBody(req.body);
    if (!v.ok) return invalid(v.code);

    // 6. Bounded, concurrency-safe idempotency scoped to (action, principal fingerprint, client key). The payload
    //    fingerprint is a one-way hash of the authority-neutral payload (lens + sanitized reason) — raw reason is
    //    never stored. Same key+payload ⇒ SAFE DUPLICATE (no second marker); same key+CHANGED payload ⇒ 409
    //    conflict; in-flight capacity exhaustion ⇒ 503 retryable. None of these emit a marker.
    const begun = req.idempotencyStore.begin(
      { actionKey: BCP_ACTION_ACK_KEY, principalFingerprint: req.principalFingerprint, clientKey: v.idempotencyKey },
      payloadFingerprint(v.lensKey, v.reasonValue ?? ''),
    );
    if (begun.status === 'duplicate' || begun.status === 'in_flight_duplicate') {
      return { httpStatus: 200, category: 'duplicate', body: { status: 'duplicate', actionKey: BCP_ACTION_ACK_KEY, alreadyAcknowledged: true } };
    }
    if (begun.status === 'conflict') {
      return { httpStatus: 409, category: 'idempotency_conflict', body: { status: 'idempotency_conflict' } };
    }
    if (begun.status === 'capacity') {
      return { httpStatus: 503, category: 'busy', body: { status: 'busy', retryable: true } };
    }

    // 7. Success: reserve → emit exactly one advisory marker → commit. Order matters (§9.11): commit the completed
    //    record ONLY after a successful emission. If the sink throws, release the reservation (no completed
    //    record) and return a safe 500 so a later retry re-attempts cleanly (never a silent duplicate, no marker).
    const reservation: IdempotencyReservation = (begun as { reservation: IdempotencyReservation }).reservation;
    try {
      req.sink.record(buildActionAuditEvent({
        actionKey: BCP_ACTION_ACK_KEY,
        actorId: req.principal?.internalUserId ?? null,
        lensKey: v.lensKey, decision: 'allow', reasonCode: 'allow', result: 'success',
        confirmationAcknowledged: true, reasonProvided: true, correlationKey: v.idempotencyKey,
      }));
    } catch {
      req.idempotencyStore.release(reservation);
      return { httpStatus: 500, category: 'error', body: { status: 'error' } };
    }
    req.idempotencyStore.commit(reservation);
    return {
      httpStatus: 200, category: 'success',
      body: { status: 'success', actionKey: BCP_ACTION_ACK_KEY, acknowledged: true, auditRecorded: true, lensKey: v.lensKey, correlationKey: v.idempotencyKey },
    };
  } catch {
    // Safe edge: never leak an exception or stack trace.
    return { httpStatus: 500, category: 'error', body: { status: 'error' } };
  }
}
