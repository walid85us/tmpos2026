// Phase 1.6 M20.13 — Identity Link AUDIT ADAPTER (server-only, default-OFF, dependency-injected).
//
// WHAT THIS IS: a dependency-injected adapter that implements the M20.11 `IdentityLinkAuditSink`
// contract by mapping the redaction-safe M20.11 `IdentityLinkAuditEvent` (M20.9 taxonomy) onto the
// existing durable append-only audit writer. It builds an `AuditEventWriteInput` carrying ONLY safe
// labels and appends it via the INJECTED writer function (the future caller supplies the real
// `writeAuditEvent`; unit tests supply a fake). It modifies NOTHING in the durable writer.
//
// WHAT THIS IS NOT (binding for M20.13):
//   - It is server-only and is imported by NOTHING active: no route, no `sessionResolve`, no UI, no
//     startup, no seed, no migration runner. It changes no existing authorization behavior.
//   - It opens NO database connection and holds NO global writer/DB client. The durable write
//     function is INJECTED. All sibling imports are `import type` (erased) except Node's `crypto`.
//   - By itself it writes NO `audit_event` row at import time; a row is appended only if a future
//     caller injects a real writer and an emit is invoked.
//
// SECURITY (binding): the produced audit input carries NO actor identifier (actorInternalUserId is
// ALWAYS null), NO provider reference, NO internal anchor reference, NO email, NO token/header/body,
// NO raw claims, and NO secret. The payload is allow-listed + scalar-only + forbidden-key guarded.
// A write failure surfaces as a redaction-safe `SafeAuditError` (fail-closed; no raw detail).

import { randomUUID } from 'crypto';
import type { AuditEventWriteInput } from './auditEventWriter';
import type { SqlExecutor } from './authorizationRepository';
import type { DecisionValue, ResultStatusValue } from './authorizationConstants';
import type {
  IdentityLinkAuditSink,
  IdentityLinkAuditEvent,
  IdentityLinkAuditOutcome,
} from './identityLinkAdminProvisioning';

// =============================================================================
// Safe payload allow-list + forbidden-key guard (the adapter's own redaction core)
// =============================================================================

/** Only these safe, non-sensitive labels may appear in the identity-link audit payload. */
export const IDENTITY_LINK_AUDIT_METADATA_ALLOWLIST: readonly string[] = [
  'actionCategory',
  'kind',
  'outcome',
  'sourceFlow',
  'reasonCode',
  'verificationMethod',
  'lifecycleState',
  'policyDecision',
  'correlationLabel',
  'environment',
  'approvalRequired',
  'sodRequired',
  'productionBlocked',
  'redactionApplied',
] as const;

/**
 * Keys that must NEVER appear in an identity-link audit payload. Mirrors the durable writer's
 * forbidden fields and adds identity-link-specific identifier/reference keys. Defense-in-depth:
 * the event type already has no such field, but the sanitizer strips them if ever present.
 */
export const IDENTITY_LINK_AUDIT_FORBIDDEN_KEYS: readonly string[] = [
  // durable-writer forbidden fields
  'accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey',
  'databaseUrl', 'connectionString', 'password', 'rawDbError', 'pan', 'cardNumber', 'providerSecret',
  // identity-link-specific identifiers/references that must never be emitted
  'firebaseUid', 'supabaseUid', 'providerUid', 'reference', 'firebaseReference', 'supabaseReference',
  'internalUserId', 'actorInternalUserId', 'anchorRef', 'email', 'requestedByRef', 'approvedByRef',
  'actorUuid', 'rawClaims', 'requestHeaders', 'requestBody', 'responseBody', 'authorizationObject',
  'token',
] as const;

const PAYLOAD_STRING_MAX = 128;

type SafeScalar = string | number | boolean;

function isSafeScalar(v: unknown): v is SafeScalar {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Reduce an arbitrary candidate to allow-listed, scalar-only, forbidden-key-free fields. Drops any
 * key not on the allow-list, any forbidden key (defense-in-depth), any non-scalar, and `undefined`.
 * Truncates long strings. Never throws.
 */
export function sanitizeIdentityLinkAuditPayload(
  input: Record<string, unknown> | null | undefined,
): Record<string, SafeScalar> {
  const out: Record<string, SafeScalar> = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (IDENTITY_LINK_AUDIT_FORBIDDEN_KEYS.includes(key)) continue;
    if (!IDENTITY_LINK_AUDIT_METADATA_ALLOWLIST.includes(key)) continue;
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (!isSafeScalar(value)) continue;
    out[key] =
      typeof value === 'string' && value.length > PAYLOAD_STRING_MAX
        ? value.slice(0, PAYLOAD_STRING_MAX)
        : value;
  }
  return out;
}

/** Build the safe, allow-listed identity-link audit payload from a (safe-by-construction) event. */
export function buildSafeIdentityLinkAuditPayload(
  event: IdentityLinkAuditEvent,
): Record<string, SafeScalar> {
  return sanitizeIdentityLinkAuditPayload({
    actionCategory: event.actionCategory,
    kind: event.kind,
    outcome: event.outcome,
    sourceFlow: event.sourceFlow,
    reasonCode: event.reasonCode,
    verificationMethod: event.verificationMethod,
    lifecycleState: event.lifecycleState,
    policyDecision: event.policyDecision,
    correlationLabel: event.correlationLabel,
    redactionApplied: true,
  });
}

// =============================================================================
// Outcome → durable decision/result mapping + safe human-readable reason
// =============================================================================

export function decisionForOutcome(outcome: IdentityLinkAuditOutcome): DecisionValue {
  switch (outcome) {
    case 'succeeded':
    case 'validated':
    case 'approved':
    case 'idempotent_existing':
      return 'allow';
    case 'rejected':
    case 'conflict':
    case 'failed':
      return 'deny';
    case 'requested':
    default:
      return 'not_applicable';
  }
}

export function resultStatusForOutcome(outcome: IdentityLinkAuditOutcome): ResultStatusValue {
  switch (outcome) {
    case 'succeeded':
    case 'validated':
    case 'approved':
    case 'idempotent_existing':
      return 'succeeded';
    case 'rejected':
    case 'conflict':
    case 'failed':
      return 'failed';
    case 'requested':
    default:
      return 'n_a';
  }
}

/** A safe, non-leaking summary sentence built ONLY from non-sensitive labels. */
export function buildSafeHumanReadableReason(event: IdentityLinkAuditEvent): string {
  const parts: string[] = [
    `Identity-link ${event.kind}`,
    `outcome=${event.outcome}`,
    `flow=${event.sourceFlow}`,
  ];
  if (event.verificationMethod) parts.push(`verification=${event.verificationMethod}`);
  if (event.lifecycleState) parts.push(`lifecycle=${event.lifecycleState}`);
  if (typeof event.policyDecision === 'boolean') parts.push(`policy=${event.policyDecision ? 'pass' : 'fail'}`);
  return `${parts.join(' ')} (redacted)`.slice(0, 256);
}

// =============================================================================
// Durable-writer mapping (no actor identity; safe enums only)
// =============================================================================

/** Safe, non-secret labels used for every identity-link durable audit row. */
export const IDENTITY_LINK_AUDIT_REQUIRED_PERMISSION = 'identity_link:admin_provisioning' as const;
export const IDENTITY_LINK_AUDIT_SOURCE_OF_TRUTH = 'identity_link_admin_provisioning' as const;
export const IDENTITY_LINK_AUDIT_EVALUATED_BY = 'identity_link_audit_adapter@v0-dev' as const;

/**
 * Map a redaction-safe identity-link audit event to the durable writer's `AuditEventWriteInput`.
 * The actor is ALWAYS null (never a provider/internal id); scope is 'none'; the taxonomy `kind`
 * becomes the `actionId`; the reason code and a safe summary carry the rest. Metadata is limited to
 * the writer's own allow-listed `phase` marker (the writer strips anything else as defense-in-depth).
 */
export function buildIdentityLinkAuditWriteInput(event: IdentityLinkAuditEvent): AuditEventWriteInput {
  const requestId =
    event.correlationLabel && event.correlationLabel.trim().length > 0
      ? event.correlationLabel.slice(0, 128)
      : randomUUID();
  return {
    requestId,
    traceId: null,
    actorInternalUserId: null, // NEVER an actor id — identity-link events carry no actor identity
    actorAuthProvider: null,
    onBehalfOfInternalUserId: null,
    scopeType: 'none',
    tenantId: null,
    storeId: null,
    actionId: event.kind,
    requiredPermission: IDENTITY_LINK_AUDIT_REQUIRED_PERMISSION,
    decision: decisionForOutcome(event.outcome),
    reasonCode: event.reasonCode ?? event.outcome,
    humanReadableReason: buildSafeHumanReadableReason(event),
    resultStatus: resultStatusForOutcome(event.outcome),
    sourceOfTruth: IDENTITY_LINK_AUDIT_SOURCE_OF_TRUTH,
    evaluatedBy: IDENTITY_LINK_AUDIT_EVALUATED_BY,
    evidenceLevel: 'durable_compliance_event',
    metadata: { phase: 'phase-1.6-m20.13' },
  };
}

// =============================================================================
// Adapter
// =============================================================================

/** A redaction-safe audit error. Carries no raw write detail (fail-closed). */
export class SafeAuditError extends Error {
  constructor() {
    super('identity_link_audit: write_failed');
    this.name = 'SafeAuditError';
  }
}

/** Result shape returned by the durable writer (subset used here). */
export interface DurableAuditWriteResult {
  eventId: string;
  requestId: string;
}

/** The injected durable write function (structurally compatible with `writeAuditEvent`). */
export type DurableAuditWriteFn = (
  event: AuditEventWriteInput,
  options?: { executor?: SqlExecutor },
) => Promise<DurableAuditWriteResult>;

export interface IdentityLinkAuditAdapterDeps {
  /** Injected durable append-only writer (e.g., the existing `writeAuditEvent`). */
  writeAuditEvent: DurableAuditWriteFn;
  /** Optional executor / tx handle forwarded to the writer. */
  executor?: SqlExecutor;
}

/**
 * Create the audit adapter that satisfies the M20.11 `IdentityLinkAuditSink` contract. `emit` maps
 * the safe event to the durable write input and appends it via the injected writer. Fail-closed: a
 * write error surfaces as SafeAuditError (no raw detail) so the caller can fail closed.
 */
export function createIdentityLinkAuditAdapter(
  deps: IdentityLinkAuditAdapterDeps,
): IdentityLinkAuditSink {
  return {
    async emit(event: IdentityLinkAuditEvent): Promise<void> {
      const input = buildIdentityLinkAuditWriteInput(event);
      try {
        await deps.writeAuditEvent(input, deps.executor ? { executor: deps.executor } : undefined);
      } catch {
        // Never surface a raw writer/DB error; fail closed with a safe error only.
        throw new SafeAuditError();
      }
    },
  };
}
