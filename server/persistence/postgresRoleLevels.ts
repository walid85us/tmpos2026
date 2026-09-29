// Phase 4.0 M7a — the PostgreSQL tenant role levels: the owner's durable edits of a built-in tenant role, read for every
// tenant route decision and written by the one command that edits them (M7A-CUSTOMERS-P3-R1; G-IAM, G-PERSIST, DA-85;
// migration 020, schema tmpos_role).
//
// THE READ (readRoleLevels, createPostgresRoleLevels). For one tenant and one role, migration 020's SECURITY DEFINER
// routine tmpos_role.m7a_role_levels answers the levels stored for it by domain — {} when nothing is stored, and then the
// role holds its catalog default. The tenant and role are the ones the admission answer selected (tenantAuthorization.ts),
// never the request's. The runtime role holds no privilege on the table; this file names none. Two callers:
//   - the tenant route authorizer, once per decided request, on the kernel's own client (createPostgresRoleLevels);
//   - the tenant command revalidator, on the committing transaction after the standing is held and re-read (readRoleLevels,
//     composed through the tenant inventory, so the administrative artifact never carries this module).
// The answer must be a JSON object naming only the domains 020 stores, each at one of the seven canonical levels: anything
// else — no row, two rows, a null, an array, another domain, a level outside the seven — is a FAULT, a throw the route
// answers as a bounded 503, never a decision and never "no edits". The canonical decision then judges the value again.
//
// THE DIRECTORY READ (readRoleLevelDirectory, createPostgresRoleLevelDirectory; M7A-CUSTOMERS-P3-R2). For GET
// /api/v1/roles/levels (server/runtime/roleLevelDirectory.ts): the stored Customers level of every editable role of one tenant
// — the trusted scope's, never the request's — in ONE statement that calls 020's read once per role. The routine is STABLE, so
// every call runs on that one statement's snapshot: the three levels are one moment's, never a mix of before and after an edit
// (three statements in one READ COMMITTED transaction would each take their own). Each answer is judged exactly as above; a
// role with nothing stored (or only 020's NULL lock row) is `stored: null`, and then it holds its catalog default, which the
// tenant root adds (tenantTransactions.ts). Anything out of shape is the same bounded fault.
//
// THE WRITE (ROLE_LEVEL_UPDATE_MUTATOR). The one business mutation the tenant store commits for PUT /api/v1/roles/levels
// (server/runtime/roleLevelUpdate.ts), handed to the store in trusted source by the tenant transaction root alone. It runs
// inside the command's transaction, after the idempotency fence and the tenant revalidator, and before the audit record and
// the completion (postgresTransactionalStore.ts commit). ONE FIXED CALL to 020's definer routine tmpos_role.m7a_role_level_set,
// whose ONE authority input is the presenting session's key — the key the revalidator just held on this transaction — from
// which the routine derives the owner, their one tenant grant and the tenant, requires that grant to be the owner role's,
// inserts the target role's lock row if it has none (a NULL level, deciding as the default), locks it FOR UPDATE and only
// then writes the level (020's ordering against a racing customer command). The role, domain and level are the planner's
// validated values; every value is bound as a parameter.
//
// ANSWERS. 'applied' only when the routine answered exactly one row naming the tenant, the actor and the grant this
// transaction revalidated, and the level it was asked to store — so every identity the audit record carries is also the one
// the database derived. No row (the routine refused the session's authority) is 'refused'; anything else is 'mismatch'.
// Neither is 'conflict' (whose sealed 409 the store would commit): both roll the whole transaction back, and the client
// gets the generic 503. A raise is not caught: the kernel rolls back, a 503 again. No row, value or driver message is logged.
//
// THE RECENT SIGN-IN, AGAIN. The edit requires one (edit_role_levels is sensitive), and the revalidator judges its deadline
// on the database clock before this mutator runs — but the routine's FOR UPDATE on the role row can then wait for a
// customer command holding it FOR SHARE. So the deadline the store handed over is judged once more, on the database clock,
// after the routine answered and before the audit record and the completion: a sign-in that went stale during the wait is
// 'refused', and the edit rolls back with everything else. A command without a deadline never reaches the routine. That is
// the whole guarantee: fresh when judged after the set routine answered, so after that routine's own lock waits; the audit
// record, the completion and COMMIT then follow with no further freshness check, so they may complete after the sign-in
// deadline (within the command's own transaction deadline).
import { authenticationFresh } from './postgresSessionStore.js';
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { EDITABLE_TENANT_ROLES, ROLE_LEVELS, ROLE_LEVEL_DOMAINS, ROLE_LEVEL_UPDATE_CONTRACT } from '../runtime/roleLevelUpdate.js';

/** One short read on every decided tenant request, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const ROLE_LEVELS_DEADLINE_MS = 3_000;
export const ROLE_LEVELS_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(ROLE_LEVELS_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(ROLE_LEVELS_DEADLINE_MS * 0.9)}ms`,
  idle: `${ROLE_LEVELS_DEADLINE_MS * 2}ms`,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A role id as migration 003 spells one: the admission's word, never trimmed or folded. */
const ROLE_ID_RE = /^[a-z_]{1,64}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('role levels answer invalid');

/** The one row of a one-row answer holding exactly `columns`, or a throw. */
function onlyRow(rows: unknown, columns: readonly string[]): Record<string, unknown> {
  if (!Array.isArray(rows) || rows.length !== 1) throw fault();
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) throw fault();
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== columns.length || !columns.every((column) => keys.includes(column))) throw fault();
  return row as Record<string, unknown>;
}

/** The routine's one jsonb answer as a frozen copy — only 020's domains, each at a canonical level — or a throw. */
function levelsOf(rows: unknown): Readonly<Record<string, string>> {
  return levelMapOf(onlyRow(rows, ['levels']).levels);
}

/** One jsonb value of 020's read as a frozen copy — only 020's domains, each at a canonical level — or a throw. */
function levelMapOf(levels: unknown): Readonly<Record<string, string>> {
  if (typeof levels !== 'object' || levels === null || Array.isArray(levels) || Object.getPrototypeOf(levels) !== Object.prototype) throw fault();
  const copy: Record<string, string> = {};
  for (const domain of Reflect.ownKeys(levels)) {
    if (typeof domain !== 'string' || !ROLE_LEVEL_DOMAINS.includes(domain)) throw fault();
    const level: unknown = (levels as Record<string, unknown>)[domain];
    if (typeof level !== 'string' || !ROLE_LEVELS.includes(level)) throw fault();
    copy[domain] = level;
  }
  return Object.freeze(copy);
}

/**
 * The stored levels of `roleId` in `tenantId`, on the caller's transaction: {} when nothing is stored. The tenant is a
 * canonical lowercase UUID and the role a role word, or this throws before any statement; any doubt about the answer throws.
 */
export async function readRoleLevels(sql: PgTransactionScope, tenantId: string, roleId: string): Promise<Readonly<Record<string, string>>> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId) || typeof roleId !== 'string' || !ROLE_ID_RE.test(roleId)) throw fault();
  return levelsOf(await sql`select tmpos_role.m7a_role_levels(${tenantId}::uuid, ${roleId}::text) as levels`);
}

/** The read the tenant route authorizer makes, over the M6 runtime client the composition root already built. */
export function createPostgresRoleLevels(deps: { readonly client: SupervisedPgClient }): (tenantId: string, roleId: string, signal: AbortSignal) => Promise<unknown> {
  const { client } = deps;
  return (tenantId: string, roleId: string, signal: AbortSignal): Promise<unknown> =>
    client.transaction(signal, ROLE_LEVELS_BOUNDS, (sql) => readRoleLevels(sql, tenantId, roleId));
}

/** One editable role's stored Customers level: null when nothing is stored, and then it holds its catalog default. */
export interface StoredRoleLevel {
  readonly roleId: string;
  readonly stored: string | null;
}

/**
 * The stored Customers level of every editable role of `tenantId`, in EDITABLE_TENANT_ROLES order, from ONE statement (one
 * snapshot, header). The tenant is a canonical lowercase UUID or this throws before any statement; any doubt about the
 * answer throws.
 */
export async function readRoleLevelDirectory(sql: PgTransactionScope, tenantId: string): Promise<readonly StoredRoleLevel[]> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fault();
  // Three roles, three calls, one statement: the list is 020's CHECK, and a longer or shorter one fails closed (an unbound
  // role is a refused parameter; an unread one leaves the route's answer out of shape).
  const [first, second, third] = EDITABLE_TENANT_ROLES;
  const row = onlyRow(await sql`select tmpos_role.m7a_role_levels(${tenantId}::uuid, ${first}::text) as r0,
    tmpos_role.m7a_role_levels(${tenantId}::uuid, ${second}::text) as r1,
    tmpos_role.m7a_role_levels(${tenantId}::uuid, ${third}::text) as r2`, ['r0', 'r1', 'r2']);
  const [domain] = ROLE_LEVEL_DOMAINS;
  return Object.freeze([first, second, third].map((roleId, i) => {
    const levels = levelMapOf(row[`r${i}`]);
    return Object.freeze({ roleId, stored: Object.prototype.hasOwnProperty.call(levels, domain) ? levels[domain] : null });
  }));
}

/** The read GET /api/v1/roles/levels makes, over the M6 runtime client the composition root already built. */
export function createPostgresRoleLevelDirectory(deps: { readonly client: SupervisedPgClient }): (tenantId: string, signal: AbortSignal) => Promise<readonly StoredRoleLevel[]> {
  const { client } = deps;
  return (tenantId: string, signal: AbortSignal): Promise<readonly StoredRoleLevel[]> =>
    client.transaction(signal, ROLE_LEVELS_BOUNDS, (sql) => readRoleLevelDirectory(sql, tenantId));
}

async function applyRoleLevelUpdate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<string> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const authNotAfter = authority?.authNotAfter ?? null;
  const { roleId, domain, level } = mutation.changes;
  // Never a call without the revalidated tenant context, the key that presented it and the recent sign-in's deadline the
  // revalidator judged: the store proved all three.
  if (context === null || context.scope !== 'tenant' || typeof sessionKey !== 'string'
    || typeof authNotAfter !== 'number' || !Number.isSafeInteger(authNotAfter) || authNotAfter < 1
    || typeof roleId !== 'string' || typeof domain !== 'string' || typeof level !== 'string') return 'unavailable';
  const rows = await sql`select o_tenant_id, o_actor_id, o_membership_id, o_level
    from tmpos_role.m7a_role_level_set(${sessionKey}::text, ${roleId}::text, ${domain}::text, ${level}::text)`;
  if (rows.length === 0) return 'refused';
  if (rows.length !== 1) return 'mismatch';
  const { o_tenant_id: tenant, o_actor_id: actor, o_membership_id: membership, o_level: stored } = rows[0];
  if (tenant !== context.tenant || actor !== context.actor || membership !== context.membershipId || stored !== level) return 'mismatch';
  // The recent sign-in, judged again now that the routine's lock wait is over (see the header).
  return (await authenticationFresh(sql, authNotAfter)) ? 'applied' : 'refused';
}

/** The mutator the tenant inventory registers for the role-level edit (server/composition/tenantTransactions.ts). */
export const ROLE_LEVEL_UPDATE_MUTATOR: AggregateMutator = Object.freeze({
  kind: ROLE_LEVEL_UPDATE_CONTRACT.kind,
  mode: 'create',
  aggregateType: ROLE_LEVEL_UPDATE_CONTRACT.aggregateType,
  apply: applyRoleLevelUpdate,
});
