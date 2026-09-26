// Phase 4.0 M7a — the PostgreSQL customer directory: the production adapter behind the tenant customer directory's port
// (server/runtime/customerDirectory.ts), over migration 017's one bounded read (M7A-CUSTOMERS-P1; G-IAM, G-PERSIST).
//
// WHAT IT ASKS. For the trusted scope the tenant authorizer selected — the actor, its account security version, the one
// tenant membership, its role and its tenant — and a validated continuation and page size, it calls
// tmpos_customer.m7a_customer_page once. The routine confirms, in the snapshot it reads the page in, that exactly this
// authority still holds, and answers a page of THAT tenant's customers, 'denied' or 'cursor_unknown'. The tenant is
// taken from the trusted scope alone and is a required argument: this adapter has no way to ask for customers without
// naming the admitted tenant, and the routine refuses a tenant that is not the named grant's. Nothing the request
// carried is a parameter here beyond the continuation's customer id and the page size, both validated by the runtime
// before this port is asked.
//
// ONE MORE ROW THAN THE PAGE. It asks for limit + 1 rows and returns at most `limit`: the extra row says that another
// page follows, without a second statement or a count.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition root already
// built — one client, one credential, one governed endpoint. Importing this file connects to nothing and reads no secret.
//
// EVERY ROW MUST NAME THE ADMITTED TENANT. The routine returns each customer's tenant beside it, and a row naming any
// other tenant is a fault — a second, independent check that a routine which lost its tenant filter (a later
// replacement, a wrong edit) could never put another tenant's customer on a page.
//
// FAIL CLOSED. A row out of shape, with a name no row can hold, or out of page order, a row of another tenant, an answer mixing a refusal with customers, an abort, a
// timeout, a lost connection and a driver error are all a THROW — an outage the route answers as a bounded 503 — never a page, and never a refusal. The
// runtime validates the answer again before any of it reaches a response. Nothing is logged: a driver error propagates
// without a message of this file's own, and the route discards it.
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import { CUSTOMER_DIRECTORY_MAX_LIMIT, inCustomerPageOrder, isStorableName } from '../runtime/customerDirectory.js';
import type { CustomerDirectoryPort, CustomerDirectoryQuery } from '../runtime/customerDirectory.js';
import type { SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/** One short read, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const CUSTOMER_DIRECTORY_DEADLINE_MS = 3_000;
export const CUSTOMER_DIRECTORY_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(CUSTOMER_DIRECTORY_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(CUSTOMER_DIRECTORY_DEADLINE_MS * 0.9)}ms`,
  idle: `${CUSTOMER_DIRECTORY_DEADLINE_MS * 2}ms`,
});

/** The columns migration 017's routine answers with. */
const ROW_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_customer_id', 'o_name'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('customer directory answer invalid');

type Row = Readonly<Record<string, unknown>>;

function rowOf(value: unknown): Row {
  if (typeof value !== 'object' || value === null) throw fault();
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== ROW_COLUMNS.length || !ROW_COLUMNS.every((c) => keys.includes(c))) throw fault();
  return value as Row;
}

/** The routine's rows as the port's answer for `tenant`; a throw for anything out of shape. */
function answerOf(rows: unknown, limit: number, tenant: string): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length > limit + 1) throw fault();
  const all = rows.map(rowOf);
  const first = all[0];
  // A refusal is the routine's only row, with every other column null.
  if (first !== undefined && first.o_outcome !== 'customer') {
    const refusal = first.o_outcome;
    if (all.length !== 1 || (refusal !== 'denied' && refusal !== 'cursor_unknown')) throw fault();
    if (first.o_tenant_id !== null || first.o_customer_id !== null || first.o_name !== null) throw fault();
    return Object.freeze({ outcome: refusal });
  }
  // Every row, the lookahead included, is checked in full, must name a distinct customer and must follow the one before
  // it in page order — the route never sees the lookahead, so an out-of-order one would otherwise pass unchecked and
  // the next page, starting after this one's last row, would skip it. Only the lookahead's presence is reported.
  const seen = new Set<string>();
  const customers = all.map((row) => {
    const { o_outcome: outcome, o_tenant_id: owner, o_customer_id: id, o_name: name } = row;
    if (outcome !== 'customer' || owner !== tenant) throw fault();
    if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) throw fault();
    if (!isStorableName(name)) throw fault();
    seen.add(id);
    return Object.freeze({ id, name });
  });
  if (!inCustomerPageOrder(customers)) throw fault();
  return Object.freeze({ outcome: 'page', customers: Object.freeze(customers.slice(0, limit)), hasMore: all.length > limit });
}

/**
 * The production customer directory over the M6 runtime client. `client` is the kernel the composition root already
 * built — one client, one credential, one governed endpoint.
 */
export function createPostgresCustomerDirectory(deps: { readonly client: SupervisedPgClient }): CustomerDirectoryPort {
  const { client } = deps;
  return Object.freeze({
    async page(scope: TrustedScope, query: CustomerDirectoryQuery, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only a tenant scope the authorizer selected, naming its tenant, is an authority.
      if (!isTrustedScope(scope) || scope.scope !== 'tenant' || scope.tenant === null || !UUID_RE.test(scope.tenant)) throw fault();
      const tenant = scope.tenant;
      const { after, limit } = query;
      if (after !== null && (typeof after !== 'string' || !UUID_RE.test(after))) throw fault();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CUSTOMER_DIRECTORY_MAX_LIMIT) throw fault();
      return client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
        const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
          from tmpos_customer.m7a_customer_page(${scope.actor}::uuid, ${scope.securityVersion}::text,
            ${scope.membershipId}::uuid, ${scope.roleId}::text, ${tenant}::uuid, ${after}::uuid, ${limit + 1}::integer)`;
        return answerOf(rows, limit, tenant);
      });
    },
  });
}
