// Phase 4.0 M5 — the tenant display-name command's mutator (owner decision D1, M5-GIAM-D1-P1; G-IAM).
//
// The one business mutation the M6 store commits for PATCH /admin/v1/tenants/display-name
// (server/runtime/tenantDisplayName.ts), handed to the store in trusted source by the transaction
// composition root. It runs inside the command's transaction, after the idempotency fence and the trusted
// context's revalidation, and before the audit record, the event and the completion
// (postgresTransactionalStore.ts commit): the store owns that order, this file owns one statement.
//
// ONE FIXED CALL. Migration 009's SECURITY DEFINER operation, tmpos_command.m5_tenant_display_name_update_v2,
// is the only path: the runtime role holds no write on public.tenant.display_name at all (009 revoked 005's
// column grant, which answered under an RLS context any session could set itself) and no longer may call
// 008's operation, which 009's supersedes with the Bidi_Control refusal; this file names no table. The
// operation locks the row, compares the version before the name, and answers one row; its version column is
// moved by 008's trigger alone. Every value is bound as a parameter.
//
// ANSWERS. 'applied' only when the operation moved the version from expectedVersion to the next;
// 'unchanged' only when it reports the name already in place at expectedVersion — the row stays locked, and
// the store records the no-op's response in this same transaction; 'conflict' and 'not_found' as reported.
// Anything else — 'invalid', a version that does not add up, a row count other than one — is a fault the
// store treats as 'unavailable': nothing commits. No row, value or driver message is logged or returned.
import type { AggregateMutator, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { TENANT_DISPLAY_NAME_CONTRACT } from '../runtime/tenantDisplayName.js';

/** What the store reads as a fault: not one of the four answers it maps. */
const FAULT = 'fault';

async function applyDisplayName(sql: PgStatement, mutation: TransactionMutation): Promise<string> {
  const { aggregateId, expectedVersion, changes } = mutation;
  const displayName = changes.displayName;
  if (typeof expectedVersion !== 'number' || typeof displayName !== 'string') return FAULT;
  const rows = await sql`select o_outcome, o_version
    from tmpos_command.m5_tenant_display_name_update_v2(${aggregateId}::uuid, ${String(expectedVersion)}::bigint, ${displayName}::text)`;
  if (rows.length !== 1) return FAULT;
  const { o_outcome: outcome, o_version: version } = rows[0];
  // bigint arrives as its decimal text: compared exactly, never through a float.
  if (outcome === 'applied') return version === String(expectedVersion + 1) ? 'applied' : FAULT;
  if (outcome === 'unchanged') return version === String(expectedVersion) ? 'unchanged' : FAULT;
  if ((outcome === 'conflict' || outcome === 'not_found') && version === null) return outcome;
  return FAULT;
}

/** The mutator the production inventory registers for the tenant display-name command. */
export const TENANT_DISPLAY_NAME_MUTATOR: AggregateMutator = Object.freeze({
  kind: TENANT_DISPLAY_NAME_CONTRACT.kind,
  mode: 'update',
  aggregateType: TENANT_DISPLAY_NAME_CONTRACT.aggregateType,
  // Its contract's scope, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'platform',
  apply: applyDisplayName,
});
