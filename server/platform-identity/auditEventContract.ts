// Phase 1.5 M9 — Inert durable AUDIT-EVENT contract (Option B).
//
// PURPOSE: declare the SHAPE of a future, DURABLE, APPEND-ONLY audit event that a
// later, separately-approved slice will persist for security-relevant decisions
// and protected actions — distinct from today's ADVISORY dev-sidecar log (M2
// auditEnvelope.ts, `evidenceLevel: 'dev_sidecar_log_advisory'`).
//
// This file is INERT (contract-only):
//   - TypeScript types + a tiny amount of guard/allow-list DATA only. No
//     functions that do work, no env/DB/network, no side effects, no runtime sink.
//   - Imported by NOTHING at runtime. Uses `import type` from the inert M9
//     constants (erased at compile time) → NO runtime imports. Consumed only by
//     the M9 diagnostic and referenced by the M9 doc.
//   - Does NOT create a table, write a row, or modify the M2 advisory envelope.
//
// APPEND-ONLY INTENT (binding, for the FUTURE table — NOT created in M9):
//   - The durable audit table is INSERT + SELECT only. No UPDATE, no DELETE.
//     Enforced later by least-privilege grants + a reject-update/delete rule +
//     RLS deny-all to anon/authenticated (the platform_identity pattern).
//
// FAIL-CLOSED WRITE STRATEGY (binding, documented for the future runtime):
//   - For SENSITIVE / state-changing protected actions, if the durable audit
//     write fails, the action FAILS CLOSED (deny/abort) — no un-audited mutation.
//   - For low-risk reads, the write may degrade to advisory + a flag. Default
//     posture is FAIL-CLOSED. (See AUDIT_WRITE_FAILURE_STRATEGY.)
//
// SECURITY (binding): references NO access token, refresh token, raw JWT, JWT
// payload, JWKS, service-role key, DB URL, connection string, password, full
// payment card/PAN, or provider secret. The actor is the app-owned
// internal_user_id (UUID) — NEVER the raw provider uid. `metadata` is allow-listed
// and redacted; raw DB errors are sanitized summaries only.

import type {
  ScopeTypeValue,
  AuthProviderValue,
  DecisionValue,
  ResultStatusValue,
  EvidenceLevel,
} from './authorizationConstants';
import { AUDIT_CONTRACT_VERSION, AUDIT_EVALUATED_BY } from './authorizationConstants';

// =============================================================================
// Metadata (allow-listed, redacted)
// =============================================================================

/**
 * Allow-listed, scalar-only metadata. Only safe, non-secret keys may ever be
 * placed here. Values are primitives (sanitized summaries) — never raw secrets,
 * never raw DB errors, never tokens.
 */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/**
 * Example allow-list of safe metadata keys a future writer MAY include. This is a
 * documentation marker — the real writer must allow-list explicitly and redact
 * everything else.
 */
export const AUDIT_METADATA_ALLOWLIST: readonly string[] = [
  'route',
  'httpStatus',
  'featureKey',
  'planTier',
  'entitlementChecked',
  'statusChecked',
  'errorSummary', // sanitized summary ONLY — never a raw DB error / stack / secret
];

// =============================================================================
// The versioned durable audit event DTO
// =============================================================================

/**
 * A durable, append-only audit event, version `audit.v1`. Persisted (in a FUTURE
 * slice) for security-relevant decisions / protected actions.
 *
 * INVARIANTS:
 *   - actorInternalUserId is the APP-OWNED id (UUID) — never the raw provider uid.
 *   - evidenceLevel distinguishes advisory dev logs from durable compliance events.
 *   - Carries NO token/JWT/secret field (see AUDIT_FORBIDDEN_FIELDS).
 *   - metadata is allow-listed + redacted; raw DB errors are sanitized summaries.
 */
export interface DurableAuditEventV1 {
  auditVersion: typeof AUDIT_CONTRACT_VERSION;

  // --- identifiers ---
  eventId: string;        // UUID (append-only primary key in the future table)
  requestId: string;      // correlates with the request pipeline
  traceId: string | null; // distributed trace id, when available

  // --- when ---
  occurredAt: string;     // ISO-8601

  // --- actor (app-owned identity only) ---
  actorInternalUserId: string | null; // UUID; NEVER the raw provider uid
  actorAuthProvider: AuthProviderValue | null;
  /** Future impersonation/support — the app-owned id acting on behalf of another. */
  onBehalfOfInternalUserId: string | null;

  // --- scope ---
  scopeType: ScopeTypeValue;
  tenantId: string | null;
  storeId: string | null;

  // --- action + decision ---
  actionId: string;
  requiredPermission: string;
  decision: DecisionValue;
  reasonCode: string;
  humanReadableReason: string; // safe, non-leaking
  resultStatus: ResultStatusValue;

  // --- provenance ---
  sourceOfTruth: string;
  evaluatedBy: string;
  evidenceLevel: EvidenceLevel;

  // --- safe, allow-listed extras ---
  metadata: AuditMetadata;
}

/** Convenience alias for the current audit contract version. */
export type DurableAuditEvent = DurableAuditEventV1;

/** Evaluator label re-exported for callers/diagnostics that build sample events. */
export const AUDIT_EVENT_EVALUATED_BY = AUDIT_EVALUATED_BY;

/** Documented fail-closed strategy for a future durable audit writer. */
export const AUDIT_WRITE_FAILURE_STRATEGY = {
  sensitiveOrStateChanging: 'fail_closed', // deny/abort the action; no un-audited mutation
  lowRiskRead: 'degrade_to_advisory_with_flag',
  default: 'fail_closed',
} as const;

/** Documented append-only intent for the future durable audit table. */
export const AUDIT_TABLE_INTENT = {
  appendOnly: true,
  allowedOps: ['insert', 'select'] as const,
  forbiddenOps: ['update', 'delete'] as const,
  rls: 'enabled_deny_all_to_anon_authenticated',
} as const;

// =============================================================================
// Forbidden-field guard (compile-time + runtime)
// =============================================================================

/**
 * Field names / categories the durable audit event MUST NEVER capture. Used by
 * the M9 diagnostic to assert no secret/token field can be present. (The names
 * appear here ONLY as a never-capture guard list — never as actual DTO fields.)
 */
export type AuditForbiddenField =
  | 'accessToken'
  | 'refreshToken'
  | 'rawJwt'
  | 'jwtPayload'
  | 'jwks'
  | 'serviceRoleKey'
  | 'databaseUrl'
  | 'connectionString'
  | 'password'
  | 'rawDbError'
  | 'pan'
  | 'cardNumber'
  | 'providerSecret';

/** Runtime mirror of AuditForbiddenField for the offline diagnostic. */
export const AUDIT_FORBIDDEN_FIELDS: readonly AuditForbiddenField[] = [
  'accessToken',
  'refreshToken',
  'rawJwt',
  'jwtPayload',
  'jwks',
  'serviceRoleKey',
  'databaseUrl',
  'connectionString',
  'password',
  'rawDbError',
  'pan',
  'cardNumber',
  'providerSecret',
];
