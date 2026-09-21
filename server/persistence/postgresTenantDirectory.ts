// Phase 4.0 M5 — the PostgreSQL tenant directory: the production adapter behind the platform tenant
// directory's port (server/runtime/tenantDirectory.ts), over migration 012's one bounded read
// (M5-GIAM-D1-P3; G-IAM).
//
// WHAT IT ASKS. For the trusted scope the canonical platform authorizer selected — the actor, its security
// version, the one platform membership and its role — and a validated continuation and page size, it calls
// tmpos_directory.m5_tenant_directory_page once. The routine confirms, in the snapshot it reads the page
// in, that exactly this authority still holds, and answers a page, 'denied' or 'cursor_unknown'. Nothing
// the request carried is a parameter here beyond the continuation's tenant id and the page size, both
// validated by the runtime before this port is asked.
//
// ONE MORE ROW THAN THE PAGE. It asks for limit + 1 rows and returns at most `limit`: the extra row says
// that another page follows, without a second statement or a count.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition root
// already built — one client, one credential, one governed endpoint. Importing this file connects to
// nothing and reads no secret.
//
// FAIL CLOSED. A row out of shape, an answer mixing a refusal with tenants, a version that does not fit the
// runtime's integers, an abort, a timeout, a lost connection and a driver error are all a THROW — an outage
// the route answers as a bounded 503 — never a page, and never a refusal. The runtime validates the answer
// again before any of it reaches a response. Nothing is logged: a driver error propagates without a message
// of this file's own, and the route discards it.
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import { TENANT_DIRECTORY_MAX_LIMIT } from '../runtime/tenantDirectory.js';
import type { TenantDirectoryPort, TenantDirectoryQuery } from '../runtime/tenantDirectory.js';
import type { SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/** One short read, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const TENANT_DIRECTORY_DEADLINE_MS = 3_000;
export const TENANT_DIRECTORY_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(TENANT_DIRECTORY_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(TENANT_DIRECTORY_DEADLINE_MS * 0.9)}ms`,
  idle: `${TENANT_DIRECTORY_DEADLINE_MS * 2}ms`,
});

/** The columns migration 012's routine answers with. */
const ROW_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_display_name', 'o_status', 'o_version'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** bigint arrives as its decimal text; a version the runtime carries exactly is at most 16 digits. */
const VERSION_RE = /^[1-9][0-9]{0,15}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('tenant directory answer invalid');

type Row = Readonly<Record<string, unknown>>;

function rowOf(value: unknown): Row {
  if (typeof value !== 'object' || value === null) throw fault();
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== ROW_COLUMNS.length || !ROW_COLUMNS.every((c) => keys.includes(c))) throw fault();
  return value as Row;
}

/** The routine's rows as the port's answer; a throw for anything out of shape. */
function answerOf(rows: unknown, limit: number): unknown {
  if (!Array.isArray(rows)) throw fault();
  const all = rows.map(rowOf);
  const first = all[0];
  // A refusal is the routine's only row, with every other column null.
  if (first !== undefined && first.o_outcome !== 'tenant') {
    const refusal = first.o_outcome;
    if (all.length !== 1 || (refusal !== 'denied' && refusal !== 'cursor_unknown')) throw fault();
    if (first.o_tenant_id !== null || first.o_display_name !== null || first.o_status !== null || first.o_version !== null) throw fault();
    return Object.freeze({ outcome: refusal });
  }
  if (all.length > limit + 1) throw fault();
  // Every row, the lookahead included, is checked in full and must name a distinct tenant; only the
  // lookahead's presence is reported.
  const seen = new Set<string>();
  const tenants = all.map((row) => {
    const { o_outcome: outcome, o_tenant_id: tenantId, o_display_name: displayName, o_status: status, o_version: version } = row;
    if (outcome !== 'tenant' || typeof tenantId !== 'string' || !UUID_RE.test(tenantId) || seen.has(tenantId)) throw fault();
    if (displayName !== null && typeof displayName !== 'string') throw fault();
    if (typeof status !== 'string' || typeof version !== 'string' || !VERSION_RE.test(version)) throw fault();
    const n = Number(version);
    if (!Number.isSafeInteger(n)) throw fault();
    seen.add(tenantId);
    return Object.freeze({ tenantId, displayName, status, version: n });
  });
  return Object.freeze({ outcome: 'page', tenants: Object.freeze(tenants.slice(0, limit)), hasMore: all.length > limit });
}

/**
 * The production tenant directory over the M6 runtime client. `client` is the kernel the composition root
 * already built — one client, one credential, one governed endpoint.
 */
export function createPostgresTenantDirectory(deps: { readonly client: SupervisedPgClient }): TenantDirectoryPort {
  const { client } = deps;
  return Object.freeze({
    async page(scope: TrustedScope, query: TenantDirectoryQuery, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only the platform scope the authorizer selected is an authority here.
      if (!isTrustedScope(scope) || scope.scope !== 'platform') throw fault();
      const { after, limit } = query;
      if (after !== null && (typeof after !== 'string' || !UUID_RE.test(after))) throw fault();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > TENANT_DIRECTORY_MAX_LIMIT) throw fault();
      return client.transaction(signal, TENANT_DIRECTORY_BOUNDS, async (sql) => {
        const rows = await sql`select o_outcome, o_tenant_id, o_display_name, o_status, o_version
          from tmpos_directory.m5_tenant_directory_page(${scope.actor}::uuid, ${scope.securityVersion}::text,
            ${scope.membershipId}::uuid, ${scope.roleId}::text, ${after}::uuid, ${limit + 1}::integer)`;
        return answerOf(rows, limit);
      });
    },
  });
}
