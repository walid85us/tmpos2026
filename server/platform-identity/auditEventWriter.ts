// Phase 1.5 M11.3 — Durable, append-only audit-event WRITER (INSERT-only).
//
// PURPOSE: persist a durable, append-only `audit_event` row for a security-relevant
// decision / protected action, realizing the M9 inert contract (DurableAuditEventV1)
// as an actual INSERT. This module is the ONLY sanctioned write path for the
// durable audit table. It performs NO authorization logic (the inert M11 resolver
// owns every decision) — it only WRITES the row it is given, after redaction.
//
// APPEND-ONLY (binding):
//   - INSERT into `audit_event` ONLY. No UPDATE / DELETE / UPSERT / ON CONFLICT /
//     ALTER / DROP / TRUNCATE. No schema/RLS change. Parameterized tagged-template
//     SQL via the existing getDb() helper (or a caller-supplied executor/tx). No
//     sql.unsafe, no dynamic SQL, no string-concatenated SQL. Table name is a
//     hardcoded literal — never caller-supplied. The DB also enforces append-only
//     via a reject-update/delete trigger; this writer simply never attempts either.
//
// REDACTION (binding): metadata is ALLOW-LISTED and SCALAR-ONLY. Forbidden keys
//   (token/JWT/JWKS/service-role/DB-URL/connection-string/password/PAN/raw-DB-error/
//   provider-secret — see AUDIT_FORBIDDEN_FIELDS) are stripped, never stored. The
//   actor is the app-owned internal_user_id (UUID) or null — NEVER the raw provider
//   uid, email, or any raw auth/Supabase/Firebase object. This module logs NOTHING
//   (no console output): it never prints the UID, email, DB URL, project ref, or any
//   secret.
//
// ISOLATION (binding): server-side only — NEVER imported by src/ (the client
// bundle). Imports NO Express, NO frontend, NO sessionResolve, NO runtime route
// wiring. It is NOT wired into /auth/session/resolve (authorization stays null
// there). Consumed by the M11.3 live diagnostic only; it changes no runtime path.

import { randomUUID } from 'crypto';
import { getDb } from './db';
// Reuse the M9 inert audit contract (types + redaction/append-only DATA only).
import {
  type DurableAuditEventV1,
  type AuditMetadata,
  AUDIT_FORBIDDEN_FIELDS,
  AUDIT_METADATA_ALLOWLIST,
  AUDIT_EVENT_EVALUATED_BY,
  AUDIT_WRITE_FAILURE_STRATEGY,
  AUDIT_TABLE_INTENT,
} from './auditEventContract';
import {
  AUDIT_CONTRACT_VERSION,
  SCOPE_TYPE_VALUES,
  AUTH_PROVIDER_VALUES,
  DECISION_VALUES,
  RESULT_STATUS_VALUES,
  EVIDENCE_LEVELS,
  type ScopeTypeValue,
  type AuthProviderValue,
  type DecisionValue,
  type ResultStatusValue,
  type EvidenceLevel,
} from './authorizationConstants';
// type-only — erased at compile time, NO runtime coupling to the repository.
import type { SqlExecutor } from './authorizationRepository';

// Re-export the strategy/intent markers so callers/diagnostics can reference the
// same binding constants the contract declares.
export { AUDIT_WRITE_FAILURE_STRATEGY, AUDIT_TABLE_INTENT };

// =============================================================================
// Metadata allow-list (writer-owned, explicit) + redaction
// =============================================================================

/**
 * The writer's EXPLICIT allow-list of metadata keys that may ever be persisted.
 * It is a curated superset of the contract's documentation allow-list plus a small
 * set of diagnostic-safe scalar keys. Everything else is stripped. This is the
 * PRIMARY redaction guard (the DB forbidden-keys CHECK is defense-in-depth only).
 */
export const AUDIT_WRITER_METADATA_ALLOWLIST: readonly string[] = [
  ...AUDIT_METADATA_ALLOWLIST,
  'check',
  'phase',
] as const;

/** Max persisted length for any string metadata value (truncate, never reject). */
const METADATA_STRING_MAX = 256;

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Redact arbitrary input into allow-listed, scalar-only metadata:
 *   - drops any key not on AUDIT_WRITER_METADATA_ALLOWLIST,
 *   - drops any key on AUDIT_FORBIDDEN_FIELDS (defense-in-depth — never allow-listed),
 *   - drops any non-scalar value (objects/arrays/functions/undefined),
 *   - truncates long strings.
 * The output is guaranteed safe to persist. Never throws; logs nothing.
 */
export function sanitizeAuditMetadata(
  input: Record<string, unknown> | null | undefined,
): AuditMetadata {
  const out: AuditMetadata = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if ((AUDIT_FORBIDDEN_FIELDS as readonly string[]).includes(key)) continue;
    if (!AUDIT_WRITER_METADATA_ALLOWLIST.includes(key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (!isScalar(value)) continue;
    out[key] =
      typeof value === 'string' && value.length > METADATA_STRING_MAX
        ? value.slice(0, METADATA_STRING_MAX)
        : value;
  }
  return out;
}

// =============================================================================
// Writer input shape (camelCase) + validation
// =============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The input a caller hands the writer. A subset of DurableAuditEventV1: the writer
 * generates `eventId` and the DB sets `occurredAt`, so neither is supplied here.
 */
export interface AuditEventWriteInput {
  requestId: string;
  traceId?: string | null;

  actorInternalUserId: string | null; // app-owned UUID or null — NEVER a provider uid
  actorAuthProvider: AuthProviderValue | null;
  onBehalfOfInternalUserId?: string | null;

  scopeType: ScopeTypeValue;
  tenantId: string | null;
  storeId: string | null;

  actionId: string;
  requiredPermission: string;
  decision: DecisionValue;
  reasonCode: string;
  humanReadableReason: string;
  resultStatus: ResultStatusValue;

  sourceOfTruth: string;
  evaluatedBy: string;
  evidenceLevel: EvidenceLevel;

  metadata?: AuditMetadata;
}

/** Non-sensitive validation error (carries a label only — never an input value). */
export class AuditEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEventValidationError';
  }
}

/**
 * Assert the event is well-formed and safe to persist. Throws
 * AuditEventValidationError (with a non-sensitive label only) on any violation.
 * Returns the event unchanged on success. Does NOT mutate; logs nothing.
 *
 * Checks: required string fields present; enums valid; actor id is a UUID or null
 * (never a raw uid/email); metadata is allow-listed, scalar-only, and free of any
 * forbidden key.
 */
export function validateAuditEventInput(event: AuditEventWriteInput): AuditEventWriteInput {
  const requireStr = (label: string, v: unknown): void => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new AuditEventValidationError(`audit event ${label} must be a non-empty string`);
    }
  };
  requireStr('requestId', event.requestId);
  requireStr('actionId', event.actionId);
  requireStr('requiredPermission', event.requiredPermission);
  requireStr('reasonCode', event.reasonCode);
  requireStr('humanReadableReason', event.humanReadableReason);
  requireStr('sourceOfTruth', event.sourceOfTruth);
  requireStr('evaluatedBy', event.evaluatedBy);

  if (!SCOPE_TYPE_VALUES.includes(event.scopeType)) {
    throw new AuditEventValidationError('audit event scopeType is not an allowed value');
  }
  if (!DECISION_VALUES.includes(event.decision)) {
    throw new AuditEventValidationError('audit event decision is not an allowed value');
  }
  if (!RESULT_STATUS_VALUES.includes(event.resultStatus)) {
    throw new AuditEventValidationError('audit event resultStatus is not an allowed value');
  }
  if (!EVIDENCE_LEVELS.includes(event.evidenceLevel)) {
    throw new AuditEventValidationError('audit event evidenceLevel is not an allowed value');
  }
  if (
    event.actorAuthProvider !== null &&
    !AUTH_PROVIDER_VALUES.includes(event.actorAuthProvider)
  ) {
    throw new AuditEventValidationError('audit event actorAuthProvider is not an allowed value');
  }

  // Actor must be the app-owned UUID or null — never a raw provider uid/email.
  if (event.actorInternalUserId !== null && !UUID_RE.test(event.actorInternalUserId)) {
    throw new AuditEventValidationError('audit event actorInternalUserId must be a UUID or null');
  }
  if (
    event.onBehalfOfInternalUserId != null &&
    !UUID_RE.test(event.onBehalfOfInternalUserId)
  ) {
    throw new AuditEventValidationError('audit event onBehalfOfInternalUserId must be a UUID or null');
  }
  if (event.tenantId !== null && !UUID_RE.test(event.tenantId)) {
    throw new AuditEventValidationError('audit event tenantId must be a UUID or null');
  }
  if (event.storeId !== null && !UUID_RE.test(event.storeId)) {
    throw new AuditEventValidationError('audit event storeId must be a UUID or null');
  }

  // Metadata must be allow-listed, scalar-only, and free of any forbidden key.
  const metadata = event.metadata ?? {};
  for (const key of Object.keys(metadata)) {
    if ((AUDIT_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      throw new AuditEventValidationError('audit event metadata contains a forbidden key');
    }
    if (!AUDIT_WRITER_METADATA_ALLOWLIST.includes(key)) {
      throw new AuditEventValidationError('audit event metadata contains a non-allow-listed key');
    }
    if (!isScalar((metadata as AuditMetadata)[key])) {
      throw new AuditEventValidationError('audit event metadata contains a non-scalar value');
    }
  }
  return event;
}

// =============================================================================
// Builders
// =============================================================================

/** Evaluator label for the M11.3 live diagnostic event. */
export const AUDIT_WRITER_LIVE_CHECK_EVALUATED_BY = 'audit_writer_live_check@v0-dev';

/**
 * Build the canonical M11.3 live-diagnostic audit event. A system/diagnostic actor
 * (no user): actor null, scope 'none', decision 'not_applicable'. `correlationId`
 * becomes the row's request_id so the diagnostic can re-query exactly its own row.
 */
export function buildDiagnosticAuditEvent(correlationId: string): AuditEventWriteInput {
  return {
    requestId: correlationId,
    traceId: null,
    actorInternalUserId: null,
    actorAuthProvider: null,
    onBehalfOfInternalUserId: null,
    scopeType: 'none',
    tenantId: null,
    storeId: null,
    actionId: 'audit.writer.live_check',
    requiredPermission: 'n_a',
    decision: 'not_applicable',
    reasonCode: 'audit_writer_live_check',
    humanReadableReason:
      'Durable audit writer live diagnostic — system-generated, no user actor.',
    resultStatus: 'succeeded',
    sourceOfTruth: 'system_diagnostic',
    evaluatedBy: AUDIT_WRITER_LIVE_CHECK_EVALUATED_BY,
    evidenceLevel: 'durable_compliance_event',
    metadata: { check: 'audit_writer_live_check', phase: 'phase-1.5-m11.3' },
  };
}

/** Inputs for an authorization-decision audit event (future runtime use). */
export interface AuthorizationDecisionAuditInput {
  requestId: string;
  traceId?: string | null;
  actorInternalUserId: string | null;
  actorAuthProvider: AuthProviderValue | null;
  onBehalfOfInternalUserId?: string | null;
  scopeType: ScopeTypeValue;
  tenantId: string | null;
  storeId: string | null;
  actionId: string;
  requiredPermission: string;
  decision: DecisionValue;
  reasonCode: string;
  humanReadableReason: string;
  resultStatus: ResultStatusValue;
  metadata?: Record<string, unknown>;
}

/**
 * Build a durable AUTHORIZATION-DECISION audit event from a server-derived
 * decision. Stamps provenance (server authorization resolver), the durable evidence
 * level, and a REDACTED (allow-listed, scalar-only) metadata. NOT wired into any
 * runtime path in M11.3 — provided for a future, separately-approved slice.
 */
export function buildAuthorizationDecisionAuditEvent(
  input: AuthorizationDecisionAuditInput,
): AuditEventWriteInput {
  return {
    requestId: input.requestId,
    traceId: input.traceId ?? null,
    actorInternalUserId: input.actorInternalUserId,
    actorAuthProvider: input.actorAuthProvider,
    onBehalfOfInternalUserId: input.onBehalfOfInternalUserId ?? null,
    scopeType: input.scopeType,
    tenantId: input.tenantId,
    storeId: input.storeId,
    actionId: input.actionId,
    requiredPermission: input.requiredPermission,
    decision: input.decision,
    reasonCode: input.reasonCode,
    humanReadableReason: input.humanReadableReason,
    resultStatus: input.resultStatus,
    sourceOfTruth: 'server_authorization_resolver',
    evaluatedBy: AUDIT_EVENT_EVALUATED_BY,
    evidenceLevel: 'durable_compliance_event',
    metadata: sanitizeAuditMetadata(input.metadata),
  };
}

// =============================================================================
// The write path (INSERT only)
// =============================================================================

/** Options for writeAuditEvent. `executor` lets a caller pass a transaction handle. */
export interface WriteAuditEventOptions {
  executor?: SqlExecutor;
}

/** The persisted-row identifiers returned by a successful insert. */
export interface WrittenAuditEvent {
  eventId: string;
  requestId: string;
}

/**
 * Persist exactly ONE durable audit_event row (INSERT only). Redacts metadata,
 * validates the event, then runs a single parameterized tagged-template INSERT via
 * the supplied executor (or the shared getDb() client). Returns the new event_id +
 * request_id. Never UPDATEs/DELETEs; never logs; never prints a secret/UID/email.
 */
export async function writeAuditEvent(
  event: AuditEventWriteInput,
  options: WriteAuditEventOptions = {},
): Promise<WrittenAuditEvent> {
  const executor: SqlExecutor = options.executor ?? getDb();

  // Redact first, then assert — the persisted metadata is always the sanitized form.
  const metadata = sanitizeAuditMetadata(event.metadata);
  const validated = validateAuditEventInput({ ...event, metadata });

  const eventId = randomUUID();

  const rows = await executor`
    insert into audit_event (
      event_id,
      audit_version,
      request_id,
      trace_id,
      actor_internal_user_id,
      actor_auth_provider,
      on_behalf_of_internal_user_id,
      scope_type,
      tenant_id,
      store_id,
      action_id,
      required_permission,
      decision,
      reason_code,
      human_readable_reason,
      result_status,
      source_of_truth,
      evaluated_by,
      evidence_level,
      metadata
    ) values (
      ${eventId},
      ${AUDIT_CONTRACT_VERSION},
      ${validated.requestId},
      ${validated.traceId ?? null},
      ${validated.actorInternalUserId},
      ${validated.actorAuthProvider},
      ${validated.onBehalfOfInternalUserId ?? null},
      ${validated.scopeType},
      ${validated.tenantId},
      ${validated.storeId},
      ${validated.actionId},
      ${validated.requiredPermission},
      ${validated.decision},
      ${validated.reasonCode},
      ${validated.humanReadableReason},
      ${validated.resultStatus},
      ${validated.sourceOfTruth},
      ${validated.evaluatedBy},
      ${validated.evidenceLevel},
      ${executor.json(metadata)}
    )
    returning event_id, request_id
  `;

  const row = rows[0];
  return { eventId: row.event_id, requestId: row.request_id };
}

/** Re-export the contract DTO type so a future runtime caller can map to it. */
export type { DurableAuditEventV1 };
