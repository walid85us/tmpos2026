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
// INSERT-ONLY MEANS NO `RETURNING` (Phase 4.0 M3 S3):
//   `RETURNING` is not a free rider on an INSERT — PostgreSQL requires SELECT privilege
//   on every column it names. The approved runtime capability for the audit principal is
//   INSERT and nothing else: migration 005 grants exactly `insert on table audit_event to
//   tmpos_audit_writer` and records that any SELECT/UPDATE/DELETE for that role would
//   contradict append-only. Measured against real PostgreSQL as that principal, the
//   identical INSERT succeeds without the clause and fails with SQLSTATE 42501,
//   "permission denied for table audit_event", with it. So the clause is gone and NOTHING
//   replaces it — no follow-up SELECT, no count, no re-read. Both receipt fields are
//   values this module already holds before the statement is sent: `event_id` is generated
//   here and `request_id` is caller-supplied and validated here. They are returned only
//   after the INSERT promise RESOLVES, so a receipt still means "the row was accepted",
//   never "the row was attempted".
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
/**
 * The executor seam, stated STRUCTURALLY: a parameterised tagged template plus the driver's
 * `json` helper, which is all this writer uses.
 *
 * It deliberately does NOT name postgres.js's `Sql`. The driver declares a transaction handle as
 * a SEPARATE interface (`TransactionSql`) that is not assignable to `Sql` — measured against the
 * pinned version — so an `executor: Sql` option would make the one thing S3 exists to do (run
 * the audit INSERT on the caller's TRANSACTION handle) fail to compile for any typed caller.
 * Both `Sql` and `TransactionSql` satisfy the shape below, so nothing that compiled before stops
 * compiling, and the transaction case now compiles too. Naming the driver here would also enrol
 * this module in the executor-containment scanner's driver-importer inventory, which is a
 * containment fact, not a typing convenience.
 */
export interface AuditSqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the driver's own generics
  (strings: TemplateStringsArray, ...values: any[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the driver's own generics
  json(value: any): any;
}

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

  // Scope fields must be MUTUALLY consistent, not merely well-typed. Reaching the database
  // to learn this is not equivalent: the failure would arrive as a raw constraint error from
  // inside a caller's transaction, having already sent a statement, and — when the event is
  // the required half of a mutation-plus-audit transaction — would abort a business mutation
  // over an input that could have been refused before anything was executed.
  //
  // The truth table below is `audit_event_scope_consistency_chk` (migration 005), restated
  // rather than derived: a check that read the migration would agree with whatever the file
  // said, including a wrong version of it. The audit-writer RLS policy
  // (tmpos_audit_writer_append) re-asserts the same tuple in its WITH CHECK, so this one rule
  // covers the constraint and the policy alike.
  //
  //   platform | none  ->  tenant_id NULL      and store_id NULL
  //   tenant           ->  tenant_id NOT NULL  and store_id NULL
  //   store            ->  tenant_id NOT NULL  and store_id NOT NULL
  //
  // Deliberately NOT a context check. An audit row records the scope that was TARGETED —
  // including by a denied or cross-scope attempt — so well-formedness is enforced here and
  // provenance is not, exactly as the migration states.
  const scopeConsistent =
    ((event.scopeType === 'platform' || event.scopeType === 'none')
      && event.tenantId === null && event.storeId === null)
    || (event.scopeType === 'tenant' && event.tenantId !== null && event.storeId === null)
    || (event.scopeType === 'store' && event.tenantId !== null && event.storeId !== null);
  if (!scopeConsistent) {
    // The label names the scope TYPE only; tenant/store ids are never echoed.
    throw new AuditEventValidationError(
      `audit event scope fields are inconsistent with scopeType '${event.scopeType}'`,
    );
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
  executor?: AuditSqlExecutor;
}

/** The persisted-row identifiers returned by a successful insert. */
export interface WrittenAuditEvent {
  eventId: string;
  requestId: string;
}

/**
 * Persist exactly ONE durable audit_event row (INSERT only). Redacts metadata, validates
 * the event — including its cross-field scope consistency — and only then runs a single
 * parameterized tagged-template INSERT via the supplied executor (or the shared getDb()
 * client). No `RETURNING`, no follow-up SELECT: see the INSERT-ONLY note in the file header.
 *
 * Returns the event_id generated here and the validated request_id, and does so ONLY after
 * the INSERT promise resolves. A rejected INSERT propagates unchanged — the caller sees a
 * failure and no receipt, which is what lets a caller that must fail closed do so. Never
 * UPDATEs/DELETEs; never logs; never prints a secret/UID/email.
 */
export async function writeAuditEvent(
  event: AuditEventWriteInput,
  options: WriteAuditEventOptions = {},
): Promise<WrittenAuditEvent> {
  const executor: AuditSqlExecutor = options.executor ?? getDb();

  // Redact first, then assert — the persisted metadata is always the sanitized form.
  const metadata = sanitizeAuditMetadata(event.metadata);
  const validated = validateAuditEventInput({ ...event, metadata });

  // Generated BEFORE the statement is sent, so the receipt never depends on reading a row
  // back. randomUUID() is crypto-grade, matching the column's gen_random_uuid() default.
  const eventId = randomUUID();

  await executor`
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
  `;

  // Reached only when the INSERT above resolved. Both values were already in hand and
  // already validated, so nothing is read back from a table this principal cannot SELECT.
  return { eventId, requestId: validated.requestId };
}

/** Re-export the contract DTO type so a future runtime caller can map to it. */
export type { DurableAuditEventV1 };
