// Phase 3.0 M2 — DEV-only, injectable, ADVISORY audit sink for controlled-action pilots.
//
// TRUTHFULNESS (binding, per Phase 3.0 M1):
//   - evidenceLevel = 'dev_sidecar_log_advisory'  → NOT compliance evidence, NEVER 'durable_compliance_event'.
//   - The event carries ONLY closed, safe fields + a validated correlation key + booleans/labels. It NEVER
//     carries the free-text reason, secrets, tokens, cookies, raw errors, stack traces, or request bodies.
//   - This sink is PROHIBITED from calling `writeAuditEvent`, `getDb()`, any durable DB/Supabase audit table,
//     any Firebase/Firestore write, the filesystem, the network, or any external/provider sink. To keep the
//     DEV advisory path FULLY DECOUPLED from the durable-audit module graph, it uses a SELF-CONTAINED scalar-
//     only metadata sanitizer below (it does NOT import from `auditEventWriter`, which transitively imports
//     `getDb`) — the sink depends only on the safe log.
//
// Server-side only. Never imported by src/ (the client bundle).

import { safeLog } from '../safe-log';

/** Self-contained, DB-free scalar-only metadata sanitizer (own-property, scalar-only, bounded). Defense-in-depth
 *  for an optional metadata seam; the pilot never passes metadata, so this returns {}. No external import. */
const METADATA_STRING_MAX = 256;
function sanitizeActionMetadata(input?: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(input, k)) continue;
    const v = (input as Record<string, unknown>)[k];
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = (typeof v === 'string' && v.length > METADATA_STRING_MAX ? v.slice(0, METADATA_STRING_MAX) : v) as string | number | boolean | null;
    }
  }
  return out;
}

export type BcpActionDecision = 'allow' | 'deny';
export type BcpActionResult = 'success' | 'denied';

/** A safe, advisory controlled-action audit event. Every field is closed/validated — NO free text. */
export interface BcpActionAuditEvent {
  actionKey: string;
  actorType: 'server_derived_synthetic';
  /** internal_user_id (app-owned); never the raw provider uid / email. */
  actorId: string | null;
  lensKey: string;
  decision: BcpActionDecision;
  reasonCode: string;
  result: BcpActionResult;
  confirmationAcknowledged: boolean;
  /** BOOLEAN only — the reason text itself is NEVER stored. */
  reasonProvided: boolean;
  /** Validated idempotency/correlation key (safe format), or 'n_a'. */
  correlationKey: string;
  /** Sanitized, allow-listed metadata (empty for the pilot). Defense-in-depth via sanitizeAuditMetadata. */
  metadata: Record<string, string | number | boolean | null>;
  evidenceLevel: 'dev_sidecar_log_advisory';
  evaluatedAt: string;
}

/** The sink contract. Implementations MUST NOT persist to a durable DB/Supabase/provider sink. */
export interface BcpActionAuditSink {
  record(event: BcpActionAuditEvent): void;
}

export interface BuildActionAuditEventInput {
  actionKey: string;
  actorId: string | null;
  lensKey: string;
  decision: BcpActionDecision;
  reasonCode: string;
  result: BcpActionResult;
  confirmationAcknowledged: boolean;
  reasonProvided: boolean;
  correlationKey: string;
  /** Optional free-form metadata; sanitized to allow-listed scalars (empty for the pilot). */
  metadata?: Record<string, unknown>;
}

/** Build a truthfully-labelled advisory action audit event. Pure, DB-free; never stamps a durable label. */
export function buildActionAuditEvent(input: BuildActionAuditEventInput): BcpActionAuditEvent {
  return {
    actionKey: input.actionKey,
    actorType: 'server_derived_synthetic',
    actorId: input.actorId,
    lensKey: input.lensKey,
    decision: input.decision,
    reasonCode: input.reasonCode,
    result: input.result,
    confirmationAcknowledged: input.confirmationAcknowledged,
    reasonProvided: input.reasonProvided,
    correlationKey: input.correlationKey,
    metadata: sanitizeActionMetadata(input.metadata), // self-contained scalar-only sanitizer; empty for the pilot
    evidenceLevel: 'dev_sidecar_log_advisory',
    evaluatedAt: new Date().toISOString(),
  };
}

/** A recording (in-memory) sink for tests + DEV. No DB, no network, no filesystem. */
export interface RecordingActionAuditSink extends BcpActionAuditSink {
  readonly events: readonly BcpActionAuditEvent[];
}

export function createRecordingActionAuditSink(): RecordingActionAuditSink {
  const events: BcpActionAuditEvent[] = [];
  return {
    events,
    record(event: BcpActionAuditEvent): void {
      events.push(event);
    },
  };
}

/** The DEFAULT runtime sink: the safe advisory server log ONLY. Never durable, never DB/Supabase/provider. */
export const advisoryLogActionAuditSink: BcpActionAuditSink = {
  record(event: BcpActionAuditEvent): void {
    safeLog.info('[bcp-action] controlled-action audit (advisory — NOT compliance evidence)', event);
  },
};
