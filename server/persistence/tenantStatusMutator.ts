// Phase 4.0 M5 — the tenant status command's mutator (M5-GIAM-D1-P2; G-IAM, GAP-13).
//
// The one business mutation the M6 store commits for PATCH /admin/v1/tenants/status
// (server/runtime/tenantStatus.ts), handed to the store in trusted source by the transaction composition
// root. It runs inside the command's transaction, after the idempotency fence and the trusted context's
// revalidation, and before the audit record, the event and the completion (postgresTransactionalStore.ts
// commit): the store owns that order, this file owns one statement.
//
// ONE FIXED CALL. Migration 010's SECURITY DEFINER operation, tmpos_command.m5_tenant_status_change, is the
// only path. No production role holds any write on public.tenant.status or on the tenant access version —
// 005 granted tmpos_app `update (display_name, legal_name)` and nothing more, 009 revoked display_name, and
// 010 grants neither column to anyone — so this is not merely the chosen path but the only reachable one,
// and this file names no table. The operation locks the row, compares the version, then requires the
// current status to be exactly the one the transition starts from; it moves the status and the access
// version together, and 008's trigger moves row_version. Every value is bound as a parameter.
//
// THE TRANSITION IS NOT THE CALLER'S TO NAME. The command carries only its target status. The status it
// must start from is derived here, in trusted source, from that target (tenantStatusPredecessor): there
// are exactly two transitions, so the pair is determined, and no request can propose a third.
//
// ANSWERS. 'applied' only when the operation moved the version from expectedVersion to the next;
// 'invalid_state' when the row is there at that version but does not hold the status the transition starts
// from — including the case where it already holds the target, which is an invalid transition and never a
// no-op; 'conflict' and 'not_found' as reported. There is no 'unchanged': this command never has one.
// Anything else — 'invalid', a version that does not add up, a row count other than one — is a fault the
// store treats as 'unavailable': nothing commits. No row, value or driver message is logged or returned.
import type { AggregateMutator, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { TENANT_STATUS_CONTRACT, tenantStatusPredecessor } from '../runtime/tenantStatus.js';

/** What the store reads as a fault: not one of the four answers it maps. */
const FAULT = 'fault';

async function applyStatus(sql: PgStatement, mutation: TransactionMutation): Promise<string> {
  const { aggregateId, expectedVersion, changes } = mutation;
  const status = changes.status;
  if (typeof expectedVersion !== 'number' || typeof status !== 'string') return FAULT;
  const fromStatus = tenantStatusPredecessor(status);
  const rows = await sql`select o_outcome, o_version
    from tmpos_command.m5_tenant_status_change(${aggregateId}::uuid, ${String(expectedVersion)}::bigint,
      ${fromStatus}::text, ${status}::text)`;
  if (rows.length !== 1) return FAULT;
  const { o_outcome: outcome, o_version: version } = rows[0];
  // bigint arrives as its decimal text: compared exactly, never through a float.
  if (outcome === 'applied') return version === String(expectedVersion + 1) ? 'applied' : FAULT;
  if ((outcome === 'conflict' || outcome === 'not_found' || outcome === 'invalid_state') && version === null) return outcome;
  return FAULT;
}

/** The mutator the production inventory registers for the tenant status command. */
export const TENANT_STATUS_MUTATOR: AggregateMutator = Object.freeze({
  kind: TENANT_STATUS_CONTRACT.kind,
  mode: 'update',
  aggregateType: TENANT_STATUS_CONTRACT.aggregateType,
  // Its contract's scope, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'platform',
  apply: applyStatus,
});
