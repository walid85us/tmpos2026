// Phase 4.0 M7b — the PostgreSQL side of the invoice void (M7B-INVOICES-VOID-P1; docs/phase-4/13, ADR-51; G-IAM, G-ISOLATION,
// G-PERSIST, G-AUDIT; migration 035, schema tmpos_invoice_void): the void's mutator (server/runtime/invoiceVoid.ts), ONE
// fixed call into 035's session-bound SECURITY DEFINER routine. Every value is a bound parameter, the version as exact
// decimal text; no table is named here. The issued reads that show the lifecycle are postgresInvoiceIssuing.ts's.
//
// THE MUTATOR (INVOICE_VOID_MUTATOR: store.invoice.void, mode update, aggregate issued_invoice, context scope 'store', audit
// subjects 'voided_invoice'). For POST /api/v1/stores/{storeId}/invoices/{id}/void, inside the command's transaction after
// the idempotency fence and the store-scope revalidation (void_issued_invoices decided again, its recent-sign-in deadline
// required and judged on the database clock) and before the audit record and the completion (postgresTransactionalStore.ts
// commit), one statement — tmpos_invoice_void.m7b_invoice_void — bound from the presenting session's key, the REVALIDATED
// trusted store (never the change set or the request target), the issued invoice (the command's aggregate id), the expected
// tenant, the expected lifecycle version (always 1 from the planner) and the reason code. It needs the deadline: a command
// without one (void_issued_invoices is sensitive, so the store always hands one) is 'unavailable' before any statement.
// Its answers, one row: 'applied' naming exactly this transaction's tenant, store, actor and grant, the version
// expectedVersion + 1 (2: voided) and the invoice asked for — answered as the bare word, so the audit record names the
// command's own invoice alone; every refusal with every other column null — 'tenant_mismatch' as 'precondition_failed'
// (rolled back, the unsealed 409), 'not_found' (rolled back, the 404: missing, another store's and another tenant's alike),
// 'invalid_state' (already void) and 'conflict' (another version, unreachable through HTTP), each the sealed 409 its
// completion alone commits, and 'refused' (rolled back, the 503: authority, a stale session or a stale sign-in the routine
// judged after its waits). Anything else — another identity, version or invoice, an unknown outcome, another row count, a
// column more or less, an identity on a refusal — is 'mismatch' (rolled back, the 503). A raise is not caught: the kernel
// rolls back, a 503, and a retry re-plans.
//
// THE RECENT SIGN-IN, AGAIN (postgresRoleLevels.ts's rule). The revalidator judges the deadline before this mutator runs and
// the routine judges the session's own authenticated_at after its last lock wait — but on minted evidence, and the header's
// FOR UPDATE and the editable-role key can wait. So after the routine answered 'applied' the deadline the store handed over
// is judged once more on the DATABASE clock (postgresSessionStore.ts authenticationFresh): a sign-in that went stale during
// the wait is 'refused', and the void rolls back with everything else. Fresh when judged after the routine's lock waits;
// the audit record, the completion and COMMIT then follow with no further freshness check. A refusal wrote nothing, so it is
// answered as it is, stale or not.
//
// DA-118 / DA-119 STAY OPEN (widened, docs/phase-4/08): a holder of tmpos_app and a live session key at Invoices >= Approve
// and Customers >= View can call this routine directly and void with no audit record, no idempotency completion and none of
// the HTTP checks; the routine's own sign-in check narrows that only to sessions whose minted authenticated_at is recent.
//
// No driver error message, row value, key or body is ever logged. IT CONSTRUCTS NOTHING AND READS NOTHING at import.
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { INVOICE_VOID_CONTRACT, isInvoiceVoidReasonCode } from '../runtime/invoiceVoid.js';
import { authenticationFresh } from './postgresSessionStore.js';
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasColumns = (row: unknown, columns: readonly string[]): row is Readonly<Record<string, unknown>> => {
  if (!isRecord(row)) return false;
  const keys = Object.keys(row);
  return keys.length === columns.length && columns.every((c) => keys.includes(c));
};
/** A safe integer in [min, max]. */
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const MAX = Number.MAX_SAFE_INTEGER;

const VOID_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id'];
/** The routine's refusals, each with every other column null; 'tenant_mismatch' is the store's 'precondition_failed'. */
const VOID_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'invalid_state', 'conflict', 'refused']);

async function applyInvoiceVoid(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const authNotAfter = authority?.authNotAfter ?? null;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { expectedTenant, reasonCode } = changes;
  // Never a call without the revalidated STORE context, the key that presented it and the recent sign-in's deadline the
  // revalidator judged; the planner's values are checked again for type and bounds.
  if (context === null || context.scope !== 'store' || !isUuid(context.tenant) || !isUuid(context.store) || typeof sessionKey !== 'string'
    || !isInt(authNotAfter, 1, MAX)) return 'unavailable';
  if (!isUuid(aggregateId) || !isUuid(expectedTenant) || !isInvoiceVoidReasonCode(reasonCode) || !isInt(expectedVersion, 1, MAX - 1)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id
    from tmpos_invoice_void.m7b_invoice_void(${sessionKey}::text, ${context.store}::uuid, ${aggregateId}::uuid, ${expectedTenant}::uuid,
      ${String(expectedVersion)}::bigint, ${reasonCode}::text)`;
  if (rows.length !== 1 || !hasColumns(rows[0], VOID_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_version: version, o_invoice_id: invoice,
  } = rows[0];
  if (outcome === 'applied') {
    // bigint arrives as its decimal text: compared exactly, never through a float.
    if (tenant !== context.tenant || store !== context.store || actor !== context.actor || membership !== context.membershipId
      || version !== String(expectedVersion + 1) || invoice !== aggregateId) return 'mismatch';
    // The recent sign-in, judged again now that the routine's lock waits are over (header).
    return (await authenticationFresh(sql, authNotAfter)) ? 'applied' : 'refused';
  }
  // A refusal names nothing: every other column null; it wrote nothing, so it is answered as it is, stale or not.
  if ([tenant, store, actor, membership, version, invoice].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && VOID_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

/** The mutator the tenant inventory registers for the void (server/composition/tenantTransactions.ts). */
export const INVOICE_VOID_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_VOID_CONTRACT.kind,
  mode: 'update',
  aggregateType: INVOICE_VOID_CONTRACT.aggregateType,
  contextScope: 'store',
  auditSubjects: 'voided_invoice',
  apply: applyInvoiceVoid,
});
