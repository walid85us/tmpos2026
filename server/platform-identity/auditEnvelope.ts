// Phase 1.5 M2 — Advisory audit decision envelope.
//
// Builds and emits a truthfully-labelled authorization-decision envelope for the
// dev-only enforcement spine. This is the runtime realization of a SUBSET of the
// accepted Phase 1.4 M3 contract (§9 decision shape, §12 truthfulness labels).
//
// TRUTHFULNESS (binding):
//   - sourceOfTruth = 'dev_asserted_snapshot'    → NOT server-authoritative.
//   - evidenceLevel = 'dev_sidecar_log_advisory' → NOT compliance evidence.
//   - The ONLY sink is the safe server log. There is NO durable audit table and
//     NO compliance-evidence claim.
//   - No secrets, raw tokens, or emails are placed in the envelope. actorId is
//     the app-owned internal_user_id (a UUID), never the raw provider uid.
//
// Server-side only. Never imported by src/.

import { randomUUID } from 'crypto';
import { safeLog } from '../safe-log';
import type { DecisionOutcome } from './permissionDecision';
import type { RequestScope } from './requestContext';

export const EVALUATED_BY = 'platform_rbac_guard@v0-dev';

export interface AuditDecisionEnvelope {
  decisionId: string;
  requestId: string;
  actionId: string;
  actorId: string | null;          // internal_user_id (UUID); never the raw provider uid
  scope: { scopeType: string; tenantId: string | null; storeId: string | null };
  requiredPermission: string;
  decision: DecisionOutcome;
  reasonCode: string;
  humanReadableReason: string;     // safe, non-leaking
  evaluatedAt: string;             // ISO-8601
  evaluatedBy: string;
  sourceOfTruth: 'dev_asserted_snapshot';
  evidenceLevel: 'dev_sidecar_log_advisory';
  previewHandling: 'n_a';
}

export interface BuildAuditEnvelopeInput {
  requestId: string;
  actionId: string;
  actorId: string | null;
  scope: RequestScope;
  requiredPermission: string;
  decision: DecisionOutcome;
  reasonCode: string;
  humanReadableReason: string;
}

export function buildAuditEnvelope(input: BuildAuditEnvelopeInput): AuditDecisionEnvelope {
  return {
    decisionId: randomUUID(),
    requestId: input.requestId,
    actionId: input.actionId,
    actorId: input.actorId,
    scope: {
      scopeType: input.scope.scopeType,
      tenantId: input.scope.tenantId,
      storeId: input.scope.storeId,
    },
    requiredPermission: input.requiredPermission,
    decision: input.decision,
    reasonCode: input.reasonCode,
    humanReadableReason: input.humanReadableReason,
    evaluatedAt: new Date().toISOString(),
    evaluatedBy: EVALUATED_BY,
    sourceOfTruth: 'dev_asserted_snapshot',
    evidenceLevel: 'dev_sidecar_log_advisory',
    previewHandling: 'n_a',
  };
}

/**
 * Emit the envelope to the ONLY M2 sink: the safe server log (advisory).
 * Passing the object through safeLog applies the server's redaction pass; the
 * envelope intentionally contains no sensitive keys.
 */
export function emitAuditEnvelope(env: AuditDecisionEnvelope): void {
  safeLog.info('[platform-identity] audit-decision (advisory — NOT compliance evidence)', env);
}
