// Phase 4.0 M5 — the PostgreSQL principal resolver: the production adapter for
// server/runtime/principals.ts, over migration 007's two routines (M5 phase (i); G-DBROLE, G-CPLOGIN).
//
// NOT COMPOSED BY ITSELF. No production module imports this file except the transaction composition
// root, which builds it only when a route actually needs an authenticated business identity. It
// constructs no client, opens nothing, reads no environment and keeps no state between calls:
// importing it connects to nothing and reads no secret.
//
// WHAT IT IS HANDED, AND WHAT IT NEVER HOLDS. The caller hands it the transaction kernel
// (supervisedPgClient.ts) over the runtime principal's client options, which db.ts builds from the
// governed endpoint classification under the verified-TLS policy — the same client the M6 store uses,
// never a second one and never a second credential. Only values cross the port. Every statement is
// fixed, schema-qualified text in this file; every value is bound as a parameter; no caller supplies
// SQL, an identifier or a fragment.
//
// AUTHORITY. The runtime role holds no privilege on platform_identity, app_user, identity_link or the
// version helper (migration 005 section 8; migration 007 section 4). This file names none of them: it
// reaches trusted identity only through 007's resolution routine and 009's platform-authority routine
// (M5-GIAM-D1-P1-R1), which run as their schema's owner and answer one bounded row. A caller cannot ask for an actor — it asks about a provider reference the
// authentication boundary already verified, and the database decides what that names.
//
// NOTHING IS LOGGED. The provider reference is bound as a parameter and never appears in a message,
// an error or a return value. A driver error is caught and discarded: the caller learns 'unavailable'
// and nothing else — no SQLSTATE, no statement, no parameter, no connection string, no stack.
//
// FAIL CLOSED, NEVER FAIL OPEN. A malformed row, an extra column, a row count other than one, an
// abort, a timeout, a lost connection and a driver error all answer 'unavailable' — never 'resolved',
// and never a fabricated principal. There is no in-memory fallback and no development shortcut: with
// no database, this port answers nothing.
import { isTrustedPrincipal, isTrustedScope } from '../runtime/principals.js';
import type { PrincipalResolution, PrincipalResolutionPort, TrustedMembership, TrustedScope } from '../runtime/principals.js';
import type { VerifiedPrincipal } from '../runtime/routes.js';
import type { PgTransactionScope, SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/**
 * A resolution is one short read. The bounds sit below the caller's deadline, as the store's do: a
 * statement that overruns is cancelled by PostgreSQL itself rather than held by this process.
 */
export const PRINCIPAL_RESOLUTION_DEADLINE_MS = 3_000;
export const PRINCIPAL_RESOLUTION_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(PRINCIPAL_RESOLUTION_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(PRINCIPAL_RESOLUTION_DEADLINE_MS * 0.9)}ms`,
  idle: `${PRINCIPAL_RESOLUTION_DEADLINE_MS * 2}ms`,
});

const REFUSED: PrincipalResolution = Object.freeze({ outcome: 'refused' });
const UNAVAILABLE: PrincipalResolution = Object.freeze({ outcome: 'unavailable' });

/** The two providers 002's audit CHECK admits; anything else is refused before a statement runs. */
const PROVIDERS: ReadonlySet<string> = new Set(['firebase', 'supabase']);
/** The longest provider reference the routine accepts; a longer one is refused without a read. */
const MAX_UID_LENGTH = 255;
/**
 * A syntactically valid reference that names nobody. Readiness must exercise the whole lookup —
 * platform_identity, then app_user, then the version helper — so a definer routine that has lost a
 * privilege, or a helper that has been dropped, reports NOT ready. An empty or malformed reference
 * would be refused by the routine's first guard, before it read anything, and would report ready on a
 * resolver that can no longer resolve anyone.
 */
const PROBE_UID = 'm5-readiness-probe-names-nobody-0000000000';

type Row = Readonly<Record<string, unknown>>;

/** Exactly one row, with exactly the columns the routine declares — or nothing is trusted. */
function onlyRow(rows: unknown, columns: readonly string[]): Row | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  const keys = Object.keys(row as Record<string, unknown>);
  if (keys.length !== columns.length || !columns.every((c) => keys.includes(c))) return null;
  return row as Row;
}

/**
 * The membership array, every field checked. The routine builds it with jsonb_build_object, so the
 * driver hands back plain objects; anything else — a string, a proxy, a missing key, an extra key —
 * makes the whole resolution unavailable rather than a principal with one grant quietly dropped.
 */
function membershipsOf(value: unknown): TrustedMembership[] | null {
  if (!Array.isArray(value)) return null;
  const out: TrustedMembership[] = [];
  const fields = ['membershipId', 'scopeType', 'tenantId', 'storeId', 'roleId', 'tenantStatus', 'storeStatus'];
  // inv: out holds a copy of each entry below i, each field read once; term: i rises to the array's length.
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const keys = Object.keys(e);
    if (keys.length !== fields.length || !fields.every((f) => keys.includes(f))) return null;
    const { membershipId, scopeType, tenantId, storeId, roleId, tenantStatus, storeStatus } = e;
    if (typeof membershipId !== 'string' || typeof roleId !== 'string') return null;
    if (scopeType !== 'platform' && scopeType !== 'tenant' && scopeType !== 'store') return null;
    if (tenantId !== null && typeof tenantId !== 'string') return null;
    if (storeId !== null && typeof storeId !== 'string') return null;
    if (tenantStatus !== null && typeof tenantStatus !== 'string') return null;
    if (storeStatus !== null && typeof storeStatus !== 'string') return null;
    out.push(Object.freeze({
      membershipId, scopeType, roleId,
      tenant: tenantId as string | null, store: storeId as string | null,
      tenantStatus: tenantStatus as string | null, storeStatus: storeStatus as string | null,
    }));
  }
  return out;
}

/** The resolved row as a TrustedPrincipal, or null — which the caller turns into 'unavailable'. */
function principalOf(row: Row): PrincipalResolution | null {
  const { outcome, actor_id: actor, account_status: accountStatus, limitation, security_version: securityVersion, memberships } = row;
  if (outcome === 'refused') return REFUSED;
  if (outcome !== 'resolved') return null;
  const grants = membershipsOf(memberships);
  if (grants === null) return null;
  const candidate = Object.freeze({
    actor, accountStatus, limitation, securityVersion, memberships: Object.freeze(grants),
  });
  if (!isTrustedPrincipal(candidate)) return null;
  return Object.freeze({ outcome: 'resolved', principal: candidate });
}

/**
 * Re-read a platform actor's authority INSIDE the caller's transaction, on the caller's own statement
 * handle (M5-GIAM-D1-P1-R1), through migration 009's m5_revalidate_platform_authority.
 *
 * It is deliberately a plain function over a transaction scope rather than a port method: it must run
 * on the SAME transaction as the mutation it guards, and a port that owned its own transaction could
 * not. The store calls it, through the revalidator the composition root builds, after the idempotency
 * fence and before any business state.
 *
 * True only when the database still holds EXACTLY the authority the scope was selected under: the account
 * neither denied nor read-only, the security version equal, exactly one active platform grant, and that
 * grant the scope's own membership with the scope's own role — locked, so a change racing the command waits
 * for it. False for every failure — a suspended or read-only account, a moved version, a grant withdrawn,
 * added, duplicated, replaced or re-roled, a scope that is not platform, a malformed answer — one value for
 * all of them: a caller cannot tell which. It supersedes 007's m5_revalidate_principal_context, which takes
 * the first grant at the scope and so could answer for a grant the request was never authorized under.
 */
export async function revalidatePlatformAuthority(
  sql: PgTransactionScope,
  scope: TrustedScope,
  // No default: a caller that forgets it would silently skip the one database-side freshness gate. Passing
  // null is how a command whose route required no recent authentication says so, explicitly.
  authNotAfter: number | null,
): Promise<boolean> {
  if (!isTrustedScope(scope) || scope.scope !== 'platform') return false;
  if (authNotAfter !== null && !(Number.isSafeInteger(authNotAfter) && authNotAfter > 0)) return false;
  try {
    // The recent-authentication deadline, judged on THIS transaction by the database's own clock
    // (M5-GIAM-D1-P2). The chain already refused a stale session before the request got here; this is the
    // same question asked again where the write happens, so evidence that expired in between commits
    // nothing. clock_timestamp() is the wall clock inside the transaction, not its start time, so a long
    // commit cannot keep stale evidence alive. Nothing here comes from the request.
    if (authNotAfter !== null) {
      const fresh = onlyRow(await sql`select (pg_catalog.clock_timestamp() <=
        pg_catalog.to_timestamp(${String(authNotAfter)}::bigint / 1000.0)) as fresh`, ['fresh']);
      if (fresh === null || fresh.fresh !== true) return false;
    }
    const rows = await sql`select outcome from tmpos_command.m5_revalidate_platform_authority(
      ${scope.actor}::uuid, ${scope.securityVersion}::text, ${scope.membershipId}::uuid, ${scope.roleId}::text)`;
    const row = onlyRow(rows, ['outcome']);
    return row !== null && row.outcome === 'valid';
  } catch {
    // A statement or connection error carries a SQLSTATE, a hint, a schema and a host:port. None of
    // that crosses this boundary: the caller learns the one value every other failure gives it. The
    // transaction is the caller's, and its rollback is the kernel's.
    return false;
  }
}

/**
 * The production resolver over the M6 runtime client. `client` is the kernel the composition root
 * already built for the transactional store — one client, one credential, one governed endpoint.
 */
export function createPostgresPrincipalResolver(deps: { readonly client: SupervisedPgClient }): PrincipalResolutionPort {
  const { client } = deps;

  const run = async <T>(signal: AbortSignal, work: (sql: PgTransactionScope) => Promise<T>, fallback: T): Promise<T> => {
    if (signal.aborted) return fallback;
    try {
      return await client.transaction(signal, PRINCIPAL_RESOLUTION_BOUNDS, work);
    } catch {
      return fallback; // an outage, an abort, an overrun or a driver fault: nothing is disclosed
    }
  };

  return Object.freeze({
    async resolve(principal: VerifiedPrincipal, signal: AbortSignal): Promise<PrincipalResolution> {
      // Refused before a statement runs, so a malformed reference costs the database nothing.
      if (typeof principal !== 'object' || principal === null) return REFUSED;
      const { authProvider, authProviderUid } = principal as unknown as Record<string, unknown>;
      if (typeof authProvider !== 'string' || !PROVIDERS.has(authProvider)) return REFUSED;
      if (typeof authProviderUid !== 'string' || authProviderUid.length === 0 || authProviderUid.length > MAX_UID_LENGTH) return REFUSED;

      return run(signal, async (sql) => {
        const rows = await sql`select outcome, actor_id, account_status, limitation, security_version, memberships
          from tmpos_identity.m5_resolve_principal(${authProvider}::text, ${authProviderUid}::text)`;
        const row = onlyRow(rows, ['outcome', 'actor_id', 'account_status', 'limitation', 'security_version', 'memberships']);
        if (row === null) return UNAVAILABLE;
        return principalOf(row) ?? UNAVAILABLE;
      }, UNAVAILABLE);
    },

    /** Readiness: the whole lookup runs, for a valid reference that names nobody, and comes back refused. */
    probe(signal: AbortSignal): Promise<boolean> {
      return run(signal, async (sql) => {
        const rows = await sql`select outcome from tmpos_identity.m5_resolve_principal('firebase'::text, ${PROBE_UID}::text)`;
        const row = onlyRow(rows, ['outcome']);
        return row !== null && row.outcome === 'refused';
      }, false);
    },
  });
}
