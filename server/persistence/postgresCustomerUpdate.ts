// Phase 4.0 M7a — the tenant customer edit's mutator (M7A-CUSTOMERS-P7; G-IAM, G-PERSIST).
//
// The one business mutation the tenant store commits for PATCH /api/v1/customers/{id} (server/runtime/customerUpdate.ts),
// handed to the store in trusted source by the tenant transaction root alone. It runs inside the command's transaction,
// after the idempotency fence and the tenant revalidator (tenantAuthorization.ts createTenantContextRevalidator), and
// before the audit record and the completion (postgresTransactionalStore.ts commit): the store owns that order, this file
// owns one statement.
//
// ONE FIXED CALL. Migration 024's SECURITY DEFINER routine, tmpos_customer_edit.m7a_customer_update, decides: the runtime
// role holds no privilege on tmpos_customer.customer at all, and this file names no table. Its authority input is the
// presenting session's key — the key the store's revalidator just held on this transaction, handed here as
// `authority.sessionKey` — from which the routine derives the actor, the one tenant grant and the tenant, restating the
// create's authority steps with the Customers threshold at Edit on the role's CURRENT level (the owner's durable edit when
// one is stored). The revalidated context's tenant is bound as p_expected_tenant: a session whose tenant is another is no
// row. Then the routine locks the customer row of that id IN THAT TENANT, compares its row version to the expected one
// FIRST, and only then compares and writes the values. Every value is bound as a parameter; for a contact the change set
// carries a flag and a string, and a written contact of '' is bound as SQL NULL (cleared), an unwritten one as NULL with
// its flag false (the routine refuses a value beside a false flag).
//
// ANSWERS (the store maps them; tenantDisplayNameMutator.ts is the update-mode precedent):
//   applied   — one row naming the tenant, actor and grant this transaction revalidated, at expectedVersion + 1;
//   unchanged — the same identities at expectedVersion: every value already held, nothing was written (sealed 200);
//   conflict  — another version, every other column null: nothing was written (the store seals the 409);
//   not_found — no customer of that id in the session's tenant (missing and foreign alike), every other column null
//               (rolled back, 404);
//   no row    — the routine refused the session's authority, the tenant or the level: 'refused' (rolled back, 503);
//   anything else — another identity, version, outcome or row count: 'mismatch' (rolled back, 503).
// A raise (a refused value, a malformed argument, an isolation other than READ COMMITTED, a lock timeout) is not caught:
// the kernel rolls back and the client gets the 503. No row, value or driver message is logged or returned.
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { CUSTOMER_UPDATE_CONTRACT } from '../runtime/customerUpdate.js';

/** A contact's bound value: NULL when not written (its flag false) or written as '' (cleared), else itself. */
const contactParam = (set: boolean, value: string): string | null => (set && value !== '' ? value : null);

async function applyCustomerUpdate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<string> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { name, setPhone, phone, setEmail, email } = changes;
  // Never a call without the revalidated tenant context and the key that presented it: the store proved both.
  if (context === null || context.scope !== 'tenant' || typeof context.tenant !== 'string' || typeof sessionKey !== 'string'
    // The planner's bound, restated: 1..2^53-2, so expected + 1 is still exact and within the column's CHECK.
    || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || expectedVersion > Number.MAX_SAFE_INTEGER - 1
    || typeof name !== 'string' || typeof setPhone !== 'boolean' || typeof phone !== 'string'
    || typeof setEmail !== 'boolean' || typeof email !== 'string') return 'unavailable';
  // An unwritten contact carries '' by contract; anything else is a plan the planner never makes.
  if ((!setPhone && phone !== '') || (!setEmail && email !== '')) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_version
    from tmpos_customer_edit.m7a_customer_update(${sessionKey}::text, ${aggregateId}::uuid, ${context.tenant}::uuid,
      ${String(expectedVersion)}::bigint, ${name}::text, ${setPhone}::boolean, ${contactParam(setPhone, phone)}::text,
      ${setEmail}::boolean, ${contactParam(setEmail, email)}::text)`;
  if (rows.length === 0) return 'refused';
  if (rows.length !== 1) return 'mismatch';
  const { o_outcome: outcome, o_tenant_id: tenant, o_actor_id: actor, o_membership_id: membership, o_version: version } = rows[0];
  const identified = tenant === context.tenant && actor === context.actor && membership === context.membershipId;
  // bigint arrives as its decimal text: compared exactly, never through a float.
  if (outcome === 'applied') return identified && version === String(expectedVersion + 1) ? 'applied' : 'mismatch';
  if (outcome === 'unchanged') return identified && version === String(expectedVersion) ? 'unchanged' : 'mismatch';
  if ((outcome === 'conflict' || outcome === 'not_found')
    && tenant === null && actor === null && membership === null && version === null) return outcome;
  return 'mismatch';
}

/** The mutator the tenant inventory registers for the customer edit (server/composition/tenantTransactions.ts). */
export const CUSTOMER_UPDATE_MUTATOR: AggregateMutator = Object.freeze({
  kind: CUSTOMER_UPDATE_CONTRACT.kind,
  mode: 'update',
  aggregateType: CUSTOMER_UPDATE_CONTRACT.aggregateType,
  // Its contract's scope, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'tenant',
  apply: applyCustomerUpdate,
});
