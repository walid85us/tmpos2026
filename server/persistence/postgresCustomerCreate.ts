// Phase 4.0 M7a — the tenant customer create's mutator (M7A-CUSTOMERS-P3; G-IAM, G-PERSIST; docs/phase-4/10 ADR-34).
//
// The one business mutation the tenant store commits for POST /api/v1/customers (server/runtime/customerCreate.ts),
// handed to the store in trusted source by the tenant transaction root alone. It runs inside the command's transaction,
// after the idempotency fence and the tenant revalidator (tenantAuthorization.ts createTenantContextRevalidator), and
// before the audit record and the completion (postgresTransactionalStore.ts commit): the store owns that order, this
// file owns one statement.
//
// ONE FIXED CALL. Migration 020's SECURITY DEFINER routine, tmpos_role.m7a_customer_create, decides — reached since
// M7A-CUSTOMERS-P6 through migration 023's routine, below, the runtime's only path (M7A-CUSTOMERS-P3-R1: 019's
// tmpos_customer_write.m7a_customer_create, whose built-in-role allow-list ignored an owner's edit, is revoked from the
// runtime role by 020): the runtime role holds no privilege on tmpos_customer.customer at all, and this file names
// no table. 020's routine derives exactly as 019's did, then decides the grant's role on its CURRENT Customers level — the
// owner's durable edit when one is stored, the catalog default otherwise — under a lock on that role's row, so an edit that
// committed first refuses the create and one racing it waits (tmpos_role.tenant_role_level). Its ONE authority
// input is the presenting session's key — the key the store's revalidator just held on this transaction, handed here as
// `authority.sessionKey` — from which the routine derives the actor, the one tenant grant and the tenant itself; no
// tenant, actor or grant is ever passed to it. The id is the runtime's new v4 id and the name the planner's normalized
// one (both checked again by the routine and 017's CHECK). Every value is bound as a parameter.
//
// M7A-CUSTOMERS-P6 UPDATE — CONTACTS. The one call is now migration 023's tmpos_customer_contact.m7a_contact_create, and
// 023 revokes 020's create from the runtime role: 023's routine judges the phone and email (NULL, or a value its column
// CHECKs admit), delegates the whole decision and the insert to 020's create unchanged — so everything above still holds
// word for word — and writes the two contacts onto exactly the row 020 inserted, in the tenant 020 derived. Its answer is
// 020's. The change set always carries phone and email as strings ('' for "not provided": a record holds no null); this
// file binds '' as SQL NULL and every other value as itself. The created_at the row gets is the column default's (the
// database clock), never a value of the runtime's.
//
// ANSWERS. 'applied' only when the routine answered exactly one row naming the tenant, the actor and the grant this
// transaction revalidated — so every identity the audit record carries is also the one the database derived. Anything
// else commits NOTHING and is never 'conflict' (whose sealed 409 the store would commit): no row (the routine refused the
// session's authority, or the role's current Customers level is below Create) is 'refused', another identity or row count
// is 'mismatch' — both roll the transaction back, the insert included, and the client gets the generic 503 (DA-70). A
// raise (a duplicate id, a refused name or contact, a malformed argument, an isolation other than READ COMMITTED) is not caught: the
// kernel rolls back, a 503 again, and a retry re-plans a fresh id. No row, value or driver message is logged or returned.
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { CUSTOMER_CREATE_CONTRACT } from '../runtime/customerCreate.js';

async function applyCustomerCreate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<string> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const { name, phone, email } = mutation.changes;
  // Never a call without the revalidated tenant context and the key that presented it: the store proved both.
  if (context === null || context.scope !== 'tenant' || typeof sessionKey !== 'string' || typeof name !== 'string'
    || typeof phone !== 'string' || typeof email !== 'string') return 'unavailable';
  const rows = await sql`select o_tenant_id, o_actor_id, o_membership_id
    from tmpos_customer_contact.m7a_contact_create(${sessionKey}::text, ${mutation.aggregateId}::uuid, ${name}::text,
      ${phone === '' ? null : phone}::text, ${email === '' ? null : email}::text)`;
  if (rows.length === 0) return 'refused';
  if (rows.length !== 1) return 'mismatch';
  const { o_tenant_id: tenant, o_actor_id: actor, o_membership_id: membership } = rows[0];
  return tenant === context.tenant && actor === context.actor && membership === context.membershipId ? 'applied' : 'mismatch';
}

/** The mutator the tenant inventory registers for the customer create (server/composition/tenantTransactions.ts). */
export const CUSTOMER_CREATE_MUTATOR: AggregateMutator = Object.freeze({
  kind: CUSTOMER_CREATE_CONTRACT.kind,
  mode: 'create',
  aggregateType: CUSTOMER_CREATE_CONTRACT.aggregateType,
  // Its contract's scope, declared (M7B-INVOICES-P1, design R4: required, never defaulted).
  contextScope: 'tenant',
  apply: applyCustomerCreate,
});
