// Phase 4.0 M7a — the PostgreSQL tenant role levels: the owner's durable edits of a built-in tenant role, read for every
// tenant route decision and written by the one command that edits them (M7A-CUSTOMERS-P3-R1; G-IAM, G-PERSIST, DA-85;
// migration 020, schema tmpos_role — and since M7A-CUSTOMERS-P4 migration 021, schema tmpos_role_edit; DA-125). Since
// M5-INVOICES-AUTH-P1 the Invoices level is stored beside the Customers one, through migration 026's own routines (schema
// tmpos_role_invoice). That level is CONFIGURATION ONLY: no invoice business operation is decided by the server on it.
//
// THE READ (readRoleLevels, createPostgresRoleLevels). For one tenant and one role, migration 020's SECURITY DEFINER
// routine tmpos_role.m7a_role_levels answers the levels stored for it by domain — {} when nothing is stored, and then the
// role holds its catalog default. The tenant and role are the ones the admission answer selected (tenantAuthorization.ts),
// never the request's. The runtime role holds no privilege on the table; this file names none. Two callers:
//   - the tenant route authorizer, once per decided request, on the kernel's own client (createPostgresRoleLevels);
//   - the tenant command revalidator, on the committing transaction after the standing is held and re-read (readRoleLevels,
//     composed through the tenant inventory, so the administrative artifact never carries this module).
// The answer must be a JSON object naming only the domains stored (ROLE_LEVEL_DOMAINS: customers, invoices; 020's read aggregates every domain), each at one of the seven canonical levels: anything
// else — no row, two rows, a null, an array, another domain, a level outside the seven — is a FAULT, a throw the route
// answers as a bounded 503, never a decision and never "no edits". The canonical decision then judges the value again.
//
// THE DIRECTORY READ (readRoleLevelDirectory, createPostgresRoleLevelDirectory; M7A-CUSTOMERS-P3-R2, P4). For GET
// /api/v1/roles/levels (server/runtime/roleLevelDirectory.ts): the stored Customers level AND the version of every editable
// role of one tenant — the trusted scope's, never the request's — in ONE statement: migration 021's STABLE definer routine
// tmpos_role_edit.m7a_role_level_states (for Invoices, 026's tmpos_role_invoice.m7a_invoice_role_level_states, of the same
// shape — the read takes the domain and picks one of the two fixed statements; any other domain throws before a statement),
// which reads 020's levels and 021's counters on that one statement's snapshot, so
// the three levels and their versions are one moment's, never a mix of before and after an edit. Its answer must be exactly
// a JSON array of three plain objects of exactly { roleId, level, version }, in EDITABLE_TENANT_ROLES order: roleId that
// role, level null (nothing stored, or only 020's NULL lock row) or one of the seven level words, version a safe integer of
// at least 0 (0: never edited since 021). Anything else is the same bounded fault. A role with nothing stored is
// `stored: null`, and then it holds its catalog default, which the tenant root adds (tenantTransactions.ts).
//
// THE WRITE (ROLE_LEVEL_UPDATE_MUTATOR). The one business mutation the tenant store commits for PUT /api/v1/roles/levels
// (server/runtime/roleLevelUpdate.ts), handed to the store in trusted source by the tenant transaction root alone. It runs
// inside the command's transaction, after the idempotency fence and the tenant revalidator, and before the audit record and
// the completion (postgresTransactionalStore.ts commit). ONE FIXED CALL (per domain, below; for Customers) to 021's definer routine
// tmpos_role_edit.m7a_role_level_set_v2 — 020's m7a_role_level_set with two preconditions — whose ONE authority input is the
// presenting session's key — the key the revalidator just held on this transaction — from which the routine derives the
// owner, their one tenant grant and the tenant, requires that grant to be the owner role's, and then: answers
// 'tenant_mismatch' when that tenant is not the asserted one (before it inserts or locks anything, in either tenant); answers
// 'version_conflict' when the role's version is not the asserted one (checked unlocked, then again under the role row FOR
// UPDATE — the lock every edit and create of that role in that tenant takes); and otherwise writes the level and moves the
// version one step on. The role, domain, level, asserted tenant and asserted version are the planner's validated values;
// every value is bound as a parameter. The runtime role no longer holds EXECUTE on 020's unconditional set (021 revoked it).
// The mutator DISPATCHES BY DOMAIN to one fixed statement each: customers -> 021's set_v2 (unchanged), invoices -> 026's
// tmpos_role_invoice.m7a_invoice_role_level_set, which has no domain parameter (the domain is fixed inside it, so an Invoices
// edit can never write a Customers row); its answer is judged identically. Any other domain is 'unavailable', before any
// statement.
//
// ANSWERS. 'applied' only when the routine answered exactly one row, outcome 'applied', naming the tenant, the actor and the
// grant this transaction revalidated, the level it was asked to store and the version exactly one past the asserted one —
// so every identity the audit record carries is also the one the database derived, and the sealed 200's version is the one
// stored. One row answering 'tenant_mismatch' or 'version_conflict' with every other column null is
// 'precondition_failed' — this mutator is the ONLY one that answers it — which the store rolls back WITHOUT a completion
// (unlike the sealed 'conflict', which commits one) and the runtime answers 409 write_conflict. No row (the routine refused
// the session's authority) is 'refused'; anything else is 'mismatch'. Neither of those is 'conflict' or
// 'precondition_failed': both roll the whole transaction back, and the client gets the generic 503. A raise is not caught:
// the kernel rolls back, a 503 again. No row, value or driver message is logged.
//
// THE RECENT SIGN-IN, AGAIN. The edit requires one (edit_role_levels is sensitive), and the revalidator judges its deadline
// on the database clock before this mutator runs — but the routine's FOR UPDATE on the role row can then wait for a
// customer command holding it FOR SHARE. So the deadline the store handed over is judged once more, on the database clock,
// after the routine answered 'applied' and before the audit record and the completion: a sign-in that went stale during the
// wait is 'refused', and the edit rolls back with everything else. A command without a deadline never reaches the routine.
// That is the whole guarantee: fresh when judged after the set routine answered, so after that routine's own lock waits; the
// audit record, the completion and COMMIT then follow with no further freshness check, so they may complete after the
// sign-in deadline (within the command's own transaction deadline). A precondition that failed writes nothing, so it is
// answered as it is, stale or not.
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

/** One editable role's stored level in the domain asked — null when nothing is stored, and then it holds its catalog default — and its version. */
export interface StoredRoleLevel {
  readonly roleId: string;
  readonly stored: string | null;
  /** 021's per-row edit counter: 0 until the first edit since 021, then one more per effective edit. */
  readonly version: number;
}

const STATE_KEYS: readonly string[] = ['roleId', 'level', 'version'];

/**
 * The stored level and version, in `domain` (customers or invoices), of every editable role of `tenantId`, in EDITABLE_TENANT_ROLES order, from ONE
 * statement (one snapshot, header). The tenant is a canonical lowercase UUID or this throws before any statement; any doubt
 * about the answer throws.
 */
export async function readRoleLevelDirectory(sql: PgTransactionScope, tenantId: string, domain: string): Promise<readonly StoredRoleLevel[]> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fault();
  // One FIXED statement per domain; any other domain throws before a statement.
  let rows: unknown;
  if (domain === 'customers') rows = await sql`select tmpos_role_edit.m7a_role_level_states(${tenantId}::uuid) as states`;
  else if (domain === 'invoices') rows = await sql`select tmpos_role_invoice.m7a_invoice_role_level_states(${tenantId}::uuid) as states`;
  else throw fault();
  const states: unknown = onlyRow(rows, ['states']).states;
  // Exactly 021's three roles — 020's CHECK — in order: a longer, shorter or reordered answer fails closed.
  if (!Array.isArray(states) || states.length !== EDITABLE_TENANT_ROLES.length) throw fault();
  return Object.freeze(EDITABLE_TENANT_ROLES.map((roleId, i) => {
    const entry: unknown = states[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) throw fault();
    const keys = Object.keys(entry);
    if (keys.length !== STATE_KEYS.length || !STATE_KEYS.every((key) => keys.includes(key))) throw fault();
    const { roleId: named, level, version } = entry as Record<string, unknown>;
    if (named !== roleId || (level !== null && (typeof level !== 'string' || !ROLE_LEVELS.includes(level)))) throw fault();
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw fault();
    return Object.freeze({ roleId, stored: level as string | null, version });
  }));
}

/** The read GET /api/v1/roles/levels (and /invoices) makes for `domain`, over the M6 runtime client the composition root already built. */
export function createPostgresRoleLevelDirectory(deps: { readonly client: SupervisedPgClient }, domain: string = 'customers'): (tenantId: string, signal: AbortSignal) => Promise<readonly StoredRoleLevel[]> {
  const { client } = deps;
  return (tenantId: string, signal: AbortSignal): Promise<readonly StoredRoleLevel[]> =>
    client.transaction(signal, ROLE_LEVELS_BOUNDS, (sql) => readRoleLevelDirectory(sql, tenantId, domain));
}

async function applyRoleLevelUpdate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<string> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const authNotAfter = authority?.authNotAfter ?? null;
  const { roleId, domain, level, expectedTenant, expectedVersion } = mutation.changes;
  // Never a call without the revalidated tenant context, the key that presented it and the recent sign-in's deadline the
  // revalidator judged: the store proved all three. The planner validated the preconditions; they are checked again here.
  if (context === null || context.scope !== 'tenant' || typeof sessionKey !== 'string'
    || typeof authNotAfter !== 'number' || !Number.isSafeInteger(authNotAfter) || authNotAfter < 1
    || typeof roleId !== 'string' || typeof domain !== 'string' || typeof level !== 'string'
    || typeof expectedTenant !== 'string' || !UUID_RE.test(expectedTenant)
    || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
    || !Number.isSafeInteger(expectedVersion + 1) || !ROLE_LEVEL_DOMAINS.includes(domain)) return 'unavailable';
  // One FIXED statement per domain, every value bound. 026's routine has no domain parameter: the domain is hard-coded in it.
  const rows = domain === 'invoices'
    ? await sql`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
      from tmpos_role_invoice.m7a_invoice_role_level_set(${sessionKey}::text, ${roleId}::text, ${level}::text,
        ${expectedTenant}::uuid, ${String(expectedVersion)}::bigint)`
    : await sql`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
      from tmpos_role_edit.m7a_role_level_set_v2(${sessionKey}::text, ${roleId}::text, ${domain}::text, ${level}::text,
        ${expectedTenant}::uuid, ${String(expectedVersion)}::bigint)`;
  if (rows.length === 0) return 'refused';
  if (rows.length !== 1) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_actor_id: actor, o_membership_id: membership, o_level: stored, o_version: version,
  } = rows[0];
  // A precondition that no longer holds: nothing was written, and every other column says so.
  if ((outcome === 'tenant_mismatch' || outcome === 'version_conflict')
    && tenant === null && actor === null && membership === null && stored === null && version === null) return 'precondition_failed';
  // bigint arrives as its decimal text: compared exactly, never through a float.
  if (outcome !== 'applied' || tenant !== context.tenant || actor !== context.actor || membership !== context.membershipId
    || stored !== level || version !== String(expectedVersion + 1)) return 'mismatch';
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
