// Phase 1.5 M1 — Platform Identity: server-side-only Postgres connection helper.
// Phase 4.0 M3 S2 — database principal separation + transaction-local tenant/store context.
//
// SECURITY:
//   - Server-side only. NEVER imported by `src/` (client). No connection string is ever
//     logged, returned, or placed in an error message; errors name the VARIABLE only.
//   - TWO principals, two variables, no fallback between them:
//       * getDb()        SUPABASE_DATABASE_URL — the migration/admin principal. It
//                        authenticates as the table OWNER, which BYPASSES Row-Level Security.
//                        Every existing DEV/admin caller uses this and is unchanged by S2.
//       * getRuntimeDb() APP_DATABASE_URL — the tenant-runtime principal. A non-owner role
//                        bound by the migration-005 policies. NO caller uses it yet: S2 builds
//                        the seam, the cutover is a later milestone, and that is precisely why
//                        gate G-DBROLE remains open.
//     A missing APP_DATABASE_URL must NEVER quietly resolve to the owner URL — that would run
//     the tenant request path with RLS bypassed, which is the exact failure S2 exists to make
//     impossible.
//
// Both clients are created lazily (on first use), so importing this module — or running the
// isolated API with the feature flag OFF — opens no connection and requires no secret.

import postgres from 'postgres';
import {
  getRequiredServerConfig,
  getRuntimePrincipalConfig,
  SUPABASE_DATABASE_URL_VAR,
  APP_DATABASE_URL_VAR,
} from './config';

type Sql = ReturnType<typeof postgres>;

/**
 * Server-side bounds, sent as startup parameters and enforced by PostgreSQL itself.
 *
 * A client-side timeout only stops THIS process waiting; it sends no cancel request, and the
 * server does not notice a departed client while it is blocked. Without these, one runaway
 * statement or one abandoned transaction holds its locks until the backend is killed by hand.
 * Both principals carry the same bounds: the admin path is no more entitled to hold a lock
 * forever than the runtime path is.
 */
export const DB_SESSION_BOUNDS = Object.freeze({
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000,
});

/**
 * The transaction-local settings the migration-005 policies read. Exported so the context
 * writer, the context reader, and the tests all name them once.
 */
export const CONTEXT_SETTINGS = Object.freeze({
  scopeType: 'app.scope_type',
  tenantId: 'app.tenant_id',
  storeId: 'app.store_id',
});

export type ScopeType = 'platform' | 'tenant' | 'store';

/** The `{scope_type, tenant_id, store_id?}` contract, mirroring the database scope shape. */
export interface TenantContext {
  scopeType: ScopeType;
  tenantId?: string | null;
  storeId?: string | null;
}

/** The tagged-template shape a postgres.js transaction handle presents. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** Anything that can open a transaction and hand back a tagged-template handle. */
export interface TransactionCapable {
  begin(fn: (tx: SqlTag) => Promise<unknown>): Promise<unknown>;
}

/**
 * Shared client options. `prepare: false` is required by a transaction-mode pooler.
 *
 * TLS IS UNCONDITIONAL, and stays that way deliberately. Deriving it from the DSN was tried and
 * removed: postgres.js resolves the endpoint from the `host` OPTION, never from a `?host=`
 * query parameter, so a URL that *looks* like a Unix socket (`postgres:///db?host=/run/pg`)
 * actually dials localhost over TCP — a rule keyed on that shape would have switched TLS off
 * for a real network connection. A hostname is not a trust boundary either: a pooler sidecar on
 * 127.0.0.1 still carries credentials over a socket someone else can bind. Callers that must
 * reach a genuinely plaintext endpoint — only the disposable-PostgreSQL suites do — pass their
 * own `ssl: false` at the call site, where the decision is visible in review.
 */
function clientOptions(_rawUrl: string, max: number) {
  return {
    ssl: 'require' as const,
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { ...DB_SESSION_BOUNDS },
  };
}

/** Request paths need more concurrency than the admin path's 3. */
const RUNTIME_POOL_MAX = 10;

/**
 * The EXACT options getRuntimeDb() applies, for a caller that must supply its own transport.
 *
 * getRuntimeDb() addresses an endpoint by URL, which cannot name a Unix socket — postgres.js
 * derives the socket path from the `host` OPTION, and silently ignores a `?host=` query
 * parameter. The disposable-PostgreSQL proof therefore builds its own client, and takes the
 * runtime principal's configuration from HERE rather than restating it: a copied constant would
 * drift from the real one and the proof would quietly stop proving anything.
 */
export function runtimeClientOptions(rawUrl: string) {
  return clientOptions(rawUrl, RUNTIME_POOL_MAX);
}

let adminSql: Sql | null = null;
let runtimeSql: Sql | null = null;

/**
 * The MIGRATION/ADMIN client, created on first use. Throws a non-sensitive error if
 * SUPABASE_DATABASE_URL is not configured — the message contains the variable NAME only.
 */
export function getDb(): Sql {
  if (adminSql) return adminSql;
  const cfg = getRequiredServerConfig();
  if (!cfg) {
    throw new Error(`${SUPABASE_DATABASE_URL_VAR} is not configured (server-side secret missing).`);
  }
  adminSql = postgres(cfg.databaseUrl, clientOptions(cfg.databaseUrl, 3));
  return adminSql;
}

/**
 * The TENANT-RUNTIME client, created on first use. Throws when APP_DATABASE_URL is absent —
 * naming that variable and nothing else. It does NOT consult SUPABASE_DATABASE_URL, and the
 * error deliberately mentions no alternative, so neither the code nor an operator reading the
 * message is nudged towards the privileged URL.
 */
export function getRuntimeDb(): Sql {
  if (runtimeSql) return runtimeSql;
  const cfg = getRuntimePrincipalConfig();
  if (!cfg) {
    throw new Error(`${APP_DATABASE_URL_VAR} is not configured (runtime-principal secret missing).`);
  }
  runtimeSql = postgres(cfg.databaseUrl, runtimeClientOptions(cfg.databaseUrl));
  return runtimeSql;
}

/** Closes the shared admin client (used by scripts and graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (adminSql) {
    const s = adminSql;
    adminSql = null;
    await s.end({ timeout: 5 });
  }
}

/** Closes the shared runtime client. */
export async function closeRuntimeDb(): Promise<void> {
  if (runtimeSql) {
    const s = runtimeSql;
    runtimeSql = null;
    await s.end({ timeout: 5 });
  }
}

/**
 * Reject a context that could not be represented in the database.
 *
 * This mirrors user_membership_scope_consistency_chk (002) and audit_event_scope_consistency_chk
 * (005): platform carries neither id, tenant carries a tenant only, store carries both. Checked
 * BEFORE the transaction opens, so a malformed context can never leave a half-installed session.
 */
export function assertTenantContext(ctx: TenantContext): void {
  const tenant = ctx.tenantId ?? null;
  const store = ctx.storeId ?? null;
  const ok =
    (ctx.scopeType === 'platform' && tenant === null && store === null)
    || (ctx.scopeType === 'tenant' && tenant !== null && store === null)
    || (ctx.scopeType === 'store' && tenant !== null && store !== null);
  if (!ok) {
    // Scope ids are opaque uuids, not secrets, but there is no reason to echo them either.
    throw new Error(`invalid tenant context for scope '${String(ctx.scopeType)}'`);
  }
}

/**
 * Run `fn` inside ONE transaction with the tenant/store context installed transaction-locally.
 *
 * `set_config(name, value, true)` — the trailing `true` is `is_local`, so PostgreSQL discards
 * the setting when the transaction ends, on COMMIT and on ROLLBACK alike. That is the whole
 * mechanism: there is no cleanup step to forget, and a connection returned to the pool cannot
 * carry a previous borrower's tenant into the next request. A session-level `SET` would have
 * exactly that defect, which is why this module issues none.
 *
 * An absent scope id is written as the empty string rather than skipped — skipping it would
 * leave whatever an earlier statement in this transaction had set, and the policies map the
 * empty string to NULL, which denies.
 */
export async function withTenantContext<T>(
  db: TransactionCapable,
  ctx: TenantContext,
  fn: (tx: SqlTag) => Promise<T>,
): Promise<T> {
  assertTenantContext(ctx);
  return db.begin(async (tx) => {
    await tx`select set_config(${CONTEXT_SETTINGS.scopeType}, ${ctx.scopeType}, true)`;
    await tx`select set_config(${CONTEXT_SETTINGS.tenantId}, ${ctx.tenantId ?? ''}, true)`;
    await tx`select set_config(${CONTEXT_SETTINGS.storeId}, ${ctx.storeId ?? ''}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Read the context currently installed on `tx`, or null when there is none.
 *
 * Missing-safe in both directions, exactly as the policy predicates are: `current_setting(name,
 * true)` returns NULL instead of raising when the setting was never set, and `nullif(..., '')`
 * turns the absent-scope sentinel back into NULL.
 */
export async function readTenantContext(tx: SqlTag): Promise<TenantContext | null> {
  const rows = await tx`select
      nullif(current_setting(${CONTEXT_SETTINGS.scopeType}, true), '') as scope_type,
      nullif(current_setting(${CONTEXT_SETTINGS.tenantId}, true), '') as tenant_id,
      nullif(current_setting(${CONTEXT_SETTINGS.storeId}, true), '') as store_id`;
  const row = rows[0] as { scope_type: string | null; tenant_id: string | null; store_id: string | null } | undefined;
  if (!row || row.scope_type === null) return null;
  return {
    scopeType: row.scope_type as ScopeType,
    tenantId: row.tenant_id,
    storeId: row.store_id,
  };
}
